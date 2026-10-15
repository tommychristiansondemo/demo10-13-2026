export function HowItWorks() {
  return (
    <div className="page how">
      <div className="page-head">
        <div>
          <h1>How it works</h1>
          <p className="muted">Architecture of this workbench and where the MCP boundary sits.</p>
        </div>
      </div>

      <div className="arch" role="img" aria-label="Architecture: browser to CloudFront to API Lambda, which calls Bedrock and two MCP servers on AgentCore Runtime">
        <div className="arch-row">
          <div className="arch-box">
            <b>Analyst browser</b>
            <span>React SPA · Cognito sign-in (PKCE) · self-registration with a chosen role</span>
          </div>
        </div>
        <div className="arch-arrow">HTTPS · X-Auth-Token (Cognito access token)</div>
        <div className="arch-row">
          <div className="arch-box edge">
            <b>Amazon CloudFront + AWS WAF</b>
            <span>www.awsteach.com · ACM certificate · Route 53 · S3 (OAC) for the SPA</span>
          </div>
        </div>
        <div className="arch-arrow">/api/* · SigV4 via Origin Access Control</div>
        <div className="arch-row">
          <div className="arch-box app">
            <b>API + AI orchestrator (AWS Lambda, streaming)</b>
            <span>Verifies the JWT and groups · runs the Bedrock Converse tool loop · assigns evidence ids · validates citations · stores runs + approvals in DynamoDB (KMS)</span>
          </div>
          <div className="arch-box model">
            <b>Amazon Bedrock</b>
            <span>Claude model chooses which MCP tools to call and writes the cited plan</span>
          </div>
        </div>
        <div className="arch-arrow boundary">MCP boundary · Streamable HTTP · IAM SigV4 · InvokeAgentRuntime</div>
        <div className="arch-row">
          <div className="arch-box claims_policy">
            <b>MCP server 1 · Claims &amp; Policy</b>
            <span>AgentCore Runtime (own container, own IAM role, own logs)</span>
            <code>list_claims · get_claim · get_policy_coverage · get_repair_estimate · get_claim_status</code>
          </div>
          <div className="arch-box damage_repair">
            <b>MCP server 2 · Vehicle Damage &amp; Repair</b>
            <span>AgentCore Runtime (own container, own IAM role, own logs)</span>
            <code>get_damage_assessment · get_repair_operations · get_parts_estimate · get_severity_indicators · reconcile_estimate</code>
          </div>
        </div>
        <div className="arch-foot">Amazon CloudWatch dashboard, alarms, structured logs and AgentCore traces · everything defined in AWS CDK</div>
      </div>

      <div className="how-grid">
        <section className="card">
          <header className="card-head"><h3>One analysis, step by step</h3></header>
          <ol className="card-body steps">
            <li>The analyst clicks <b>Run AI analysis</b>; the API verifies the analyst's Cognito group.</li>
            <li>The orchestrator opens an MCP session to each runtime and calls <code>tools/list</code>. Tools are offered to the model as <code>claims_policy__*</code> and <code>damage_repair__*</code>.</li>
            <li>The model calls tools (often in parallel). Every result is labeled <b>E1, E2…</b> and streamed to this page.</li>
            <li>The shop estimate from server 1 is passed into <code>reconcile_estimate</code> on server 2: data crosses the MCP boundary through the agent.</li>
            <li>The model finishes with <code>submit_recommendation</code>. The API drops citations to evidence that does not exist and checks both servers were used.</li>
            <li>A supervisor approves, returns or rejects. Decisions are conditional writes (first decision wins) and audit-logged.</li>
          </ol>
        </section>
        <section className="card">
          <header className="card-head"><h3>Security choices</h3></header>
          <ul className="card-body steps">
            <li>No AWS credentials in the browser; the runtimes accept only SigV4 from the API role.</li>
            <li>Least-privilege IAM: the API may invoke exactly two runtimes and one model.</li>
            <li>Customer-supplied text (claimant statements) is treated as untrusted data. Try claim <b>CLM-24835</b>.</li>
            <li>Tool outputs carry computed verdicts and totals so the model quotes rather than calculates.</li>
            <li>Human approval is required; the agent cannot pay, deny or close anything.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
