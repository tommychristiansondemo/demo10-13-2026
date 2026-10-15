/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react';
import { get } from '../api';
import { runtimeConfig } from '../auth';

export function Inventory() {
  const [inv, setInv] = useState<any>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    get('/api/insights/inventory').then(setInv, (e) => setError(e.message));
  }, []);
  if (error) return <div className="page"><div className="alert bad">{error}</div></div>;
  if (!inv) return <div className="page"><span className="spinner" /> Reading CloudFormation, AgentCore, Lambda and Cognito…</div>;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Live inventory</h1>
          <p className="muted">Read live from the AWS account at {new Date(inv.generatedAt).toLocaleString()} (cached for 60 s).</p>
        </div>
      </div>
      <div className="stats">
        <Stat n={inv.totals.stacks} label="CloudFormation stacks" />
        <Stat n={inv.totals.resources} label="resources" />
        <Stat n={inv.totals.distinctResourceTypes} label="distinct resource types" />
        <Stat n={inv.totals.awsServices} label="AWS services" />
        {Object.entries(inv.cognitoUsersByGroup).map(([g, n]) => <Stat key={g} n={n as number} label={`users in ${g}`} />)}
      </div>
      {inv.modelRouting?.activeModel && (
        <section className="card routing">
          <h2>Workbench LLM right now <span className="muted small">(AWS AppConfig, chosen by students)</span></h2>
          <p>
            <strong>{inv.modelRouting.activeModel.name ?? inv.modelRouting.activeModel}</strong>{' '}
            <span className="muted">{inv.modelRouting.activeModel.provider} · <code>{inv.modelRouting.activeModel.modelId}</code></span>
          </p>
          <p className="muted small">
            Preferences: quality {inv.modelRouting.weights.quality}% · cost {inv.modelRouting.weights.cost}% · latency {inv.modelRouting.weights.latency}% —
            set by {inv.modelRouting.updatedBy} {new Date(inv.modelRouting.updatedAt).toLocaleString()}. Change it on the Workbench's{' '}
            <a href={`${runtimeConfig().workbenchUrl ?? ''}/models`}>Model routing</a> page; see what each model costs on the Costs tab.
          </p>
        </section>
      )}
      {inv.knowledgeBase?.id && (
        <section className="card">
          <h2>Bedrock Knowledge Base <span className="muted small">(the agent's claims-handling manual)</span></h2>
          <dl className="facts">
            <dt>Name</dt><dd><code>{inv.knowledgeBase.name}</code> · {inv.knowledgeBase.status} · <code>{inv.knowledgeBase.id}</code></dd>
            <dt>Embeddings</dt><dd>{inv.knowledgeBase.embeddingModel} ({inv.knowledgeBase.dimensions} dimensions)</dd>
            <dt>Vector store</dt><dd>{inv.knowledgeBase.vectorStore} · <code className="wrap">{inv.knowledgeBase.vectorIndex}</code></dd>
            <dt>Data source</dt><dd>{inv.knowledgeBase.dataSource?.name} ({inv.knowledgeBase.dataSource?.status})</dd>
            {inv.knowledgeBase.lastIngestion && (
              <><dt>Last ingestion</dt><dd>{inv.knowledgeBase.lastIngestion.status} · {new Date(inv.knowledgeBase.lastIngestion.updatedAt).toLocaleString()} · {inv.knowledgeBase.lastIngestion.statistics?.numberOfNewDocumentsIndexed ?? 0} new, {inv.knowledgeBase.lastIngestion.statistics?.numberOfModifiedDocumentsIndexed ?? 0} modified, {inv.knowledgeBase.lastIngestion.statistics?.numberOfDocumentsFailed ?? 0} failed documents</dd></>
            )}
          </dl>
        </section>
      )}
      <section className="card">
        <h2>AWS services in use</h2>
        <div className="chips">{inv.awsServices.map((s: string) => <span key={s} className="chip">{s}</span>)}</div>
      </section>
      <section className="card">
        <h2>Stacks</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Stack</th><th>Status</th><th className="num">Resources</th><th>Last updated</th><th>Description</th></tr></thead>
            <tbody>
              {inv.stacks.map((s: any) => (
                <tr key={s.name}><td><code>{s.name}</code></td><td>{s.status}</td><td className="num">{s.resources}</td><td>{s.lastUpdated ? new Date(s.lastUpdated).toLocaleString() : '-'}</td><td className="muted">{s.description ?? ''}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="two-col">
        <section className="card">
          <h2>MCP servers on AgentCore Runtime</h2>
          {inv.agentCoreRuntimes.map((r: any) => (
            <dl key={r.arn} className="facts">
              <dt>Runtime</dt><dd><code>{r.name}</code> · {r.status} · v{r.version}</dd>
              <dt>Protocol</dt><dd>{r.protocol} · network {r.network} · inbound {r.inboundAuth}</dd>
              <dt>Image</dt><dd><code className="wrap">{r.image}</code></dd>
            </dl>
          ))}
        </section>
        <section className="card">
          <h2>Lambda functions</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Function</th><th>Runtime</th><th className="num">MB</th><th>Model</th></tr></thead>
              <tbody>
                {inv.lambdaFunctions.map((f: any) => (
                  <tr key={f.name}><td><code>{f.name}</code><div className="muted small">{f.description}</div></td><td>{f.runtime} {f.architecture}</td><td className="num">{f.memoryMb}</td><td>{f.modelId ? <code>{f.modelId}</code> : '-'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <section className="card">
        <h2>Resources by type</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>CloudFormation resource type</th><th className="num">Count</th></tr></thead>
            <tbody>{Object.entries(inv.resourceTypes).map(([t, n]) => <tr key={t}><td><code>{t}</code></td><td className="num">{n as number}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const Stat = ({ n, label }: { n: number; label: string }) => (
  <div className="stat"><div className="stat-n">{n}</div><div className="muted small">{label}</div></div>
);
