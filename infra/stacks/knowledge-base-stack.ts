// Amazon Bedrock Knowledge Base: the (synthetic) Lakeshore Mutual claims-handling manual, so the agent can cite
// procedures alongside the facts it gets from the two MCP servers.
//   docs/kb/claims-manual/*.md -> private S3 bucket -> Bedrock KB data source (chunking + Titan Text Embeddings V2)
//   -> Amazon S3 Vectors index (serverless vector store: pay per use, no cluster to keep running)
// The API Lambda calls bedrock-agent-runtime:Retrieve as the agent's knowledge_base__search_guidelines tool.
import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DOCS = path.join(ROOT, 'docs/kb/claims-manual');
export const KB_NAME = 'claims-handling-manual';
const EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
const DIMENSIONS = 1024;

export class KnowledgeBaseStack extends cdk.Stack {
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseArn: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const docs = new s3.Bucket(this, 'ManualDocs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const upload = new s3deploy.BucketDeployment(this, 'UploadManual', {
      sources: [s3deploy.Source.asset(DOCS)],
      destinationBucket: docs,
      destinationKeyPrefix: 'claims-manual/',
      prune: true,
      memoryLimit: 512,
    });

    // --- vector store: S3 Vectors bucket + index sized for Titan Text Embeddings V2 (1024 dims, cosine)
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', { vectorBucketName: `claims-wb-kb-${this.account}` });
    const index = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName: vectorBucket.vectorBucketName!,
      indexName: 'claims-manual',
      dataType: 'float32',
      dimension: DIMENSIONS,
      distanceMetric: 'cosine',
      // Bedrock stores the chunk text and its metadata JSON on each vector; filterable metadata is limited to 2 KB,
      // so these two keys must be non-filterable or ingestion fails on longer chunks.
      metadataConfiguration: { nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'] },
    });
    index.addDependency(vectorBucket);

    // --- service role Bedrock assumes to read the docs, embed them and write/query vectors
    const role = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*` },
        },
      }),
      description: 'Bedrock Knowledge Base claims-handling-manual: read docs, embed, read/write S3 Vectors',
    });
    docs.grantRead(role);
    role.addToPolicy(new iam.PolicyStatement({ sid: 'Embed', actions: ['bedrock:InvokeModel'], resources: [`arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL}`] }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'VectorIndex',
      actions: ['s3vectors:PutVectors', 's3vectors:GetVectors', 's3vectors:DeleteVectors', 's3vectors:QueryVectors', 's3vectors:GetIndex', 's3vectors:ListVectors'],
      resources: [index.attrIndexArn],
    }));

    const kb = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: KB_NAME,
      description: 'Synthetic Lakeshore Mutual claims-handling manual (authority, coverage, estimates, total loss, SIU, injury, subrogation, glass/CAT)',
      roleArn: role.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL}`,
          embeddingModelConfiguration: { bedrockEmbeddingModelConfiguration: { dimensions: DIMENSIONS, embeddingDataType: 'FLOAT32' } },
        },
      },
      storageConfiguration: { type: 'S3_VECTORS', s3VectorsConfiguration: { indexArn: index.attrIndexArn } },
    });
    kb.node.addDependency(role); // the role's policy must exist before Bedrock validates access

    const source = new bedrock.CfnDataSource(this, 'ManualSource', {
      knowledgeBaseId: kb.attrKnowledgeBaseId,
      name: 'claims-manual-sections',
      description: 'docs/kb/claims-manual/CHM-xxx.md: one document per manual section',
      dataDeletionPolicy: 'DELETE',
      dataSourceConfiguration: { type: 'S3', s3Configuration: { bucketArn: docs.bucketArn, inclusionPrefixes: ['claims-manual/'] } },
      vectorIngestionConfiguration: {
        // One file per manual section and no further chunking: every vector is a whole section that carries its id
        // (CHM-xxx), so the agent can cite it. Fixed-size chunks split passages away from their section headings.
        chunkingConfiguration: { chunkingStrategy: 'NONE' },
      },
    });

    // Start an ingestion job whenever the manual's content changes (the hash is part of the physical id).
    // It runs asynchronously; scripts/kb_sync.py waits for it during deployment.
    const hash = createHash('sha256').update(readdirSync(DOCS).sort().map((f) => readFileSync(path.join(DOCS, f), 'utf8')).join('\n')).digest('hex').slice(0, 16);
    const ingest = new cr.AwsCustomResource(this, 'StartIngestion', {
      onUpdate: {
        service: 'bedrock-agent',
        action: 'StartIngestionJob',
        parameters: { knowledgeBaseId: kb.attrKnowledgeBaseId, dataSourceId: source.attrDataSourceId, description: `CDK deploy, manual ${hash}` },
        physicalResourceId: cr.PhysicalResourceId.of(`ingest-${hash}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['bedrock:StartIngestionJob'], resources: [kb.attrKnowledgeBaseArn] }),
      ]),
      installLatestAwsSdk: false,
    });
    ingest.node.addDependency(upload);
    ingest.node.addDependency(source);

    this.knowledgeBaseId = kb.attrKnowledgeBaseId;
    this.knowledgeBaseArn = kb.attrKnowledgeBaseArn;
    new cdk.CfnOutput(this, 'KnowledgeBaseId', { value: kb.attrKnowledgeBaseId });
    new cdk.CfnOutput(this, 'DataSourceId', { value: source.attrDataSourceId });
    new cdk.CfnOutput(this, 'ManualBucket', { value: docs.bucketName });
    new cdk.CfnOutput(this, 'VectorIndexArn', { value: index.attrIndexArn });
  }
}
