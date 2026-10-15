# Claims Intelligence Workbench

A small, enterprise-style auto-claims application for an AI-development class. A claims analyst opens a simulated auto
claim, reviews incident, coverage, shop estimate and a mock vehicle-damage assessment, and asks an **Amazon Bedrock**
agent for a **grounded next-action plan**. The agent gets its facts from **two independently deployed MCP servers on
Amazon Bedrock AgentCore Runtime**. Every statement in the plan cites evidence (`E1`, `E2`, ...) and a supervisor
approves, returns or rejects it.

> Training demo. All data is synthetic: carriers, people, VINs, shops and policies are fictional. The app is inspired by
> the collision-repair claims industry but is not affiliated with, or branded as, CCC Intelligent Solutions or any insurer.

```
Analyst browser (React SPA, Cognito PKCE)
        │  HTTPS www.awsteach.com
        ▼
CloudFront + WAF + ACM + Route 53 ──► S3 (static SPA, OAC)
        │  /api/*  (SigV4 via Origin Access Control)
        ▼
API + AI orchestrator  (Lambda, Node 22, response streaming)  ──►  Amazon Bedrock (Claude, Converse tool use)
        │  MCP over Streamable HTTP, IAM SigV4, InvokeAgentRuntime
        ├──────────────────────────────┐
        ▼                              ▼
MCP server 1: Claims & Policy     MCP server 2: Vehicle Damage & Repair
AgentCore Runtime (container)     AgentCore Runtime (container)
        └──── CloudWatch logs, metrics, dashboard, alarms, AgentCore traces ────┘
DynamoDB (KMS) stores analysis runs + approval decisions. Everything is AWS CDK (TypeScript).
```

## The two MCP servers

| Server | Runtime name | Tools |
|---|---|---|
| Claims & Policy | `claims_policy_mcp` | `list_claims`, `get_claim`, `get_policy_coverage` (computed coverage verdict), `get_repair_estimate`, `get_claim_status` |
| Vehicle Damage & Repair | `damage_repair_mcp` | `get_damage_assessment`, `get_repair_operations`, `get_parts_estimate`, `get_severity_indicators` (total-loss ratio), `reconcile_estimate` |

Each is its own container, IAM execution role, runtime ARN and log group. The browser never connects to them: only the
API Lambda's role may call `bedrock-agentcore:InvokeAgentRuntime` on exactly these two ARNs. The orchestrator uses the
**official MCP TypeScript SDK** with a SigV4-signing `fetch` (`services/api/src/sigv4-fetch.ts`).

`reconcile_estimate` makes the boundary visible: the agent reads the shop estimate from server 1 and passes every line
to server 2, which reports unsupported lines and required operations the shop left out.

## Synthetic claims (8)

| Claim | Scenario | Expected disposition |
|---|---|---|
| **CLM-24817** (demo) | Rear-ended at a light; estimate has 2 unsupported front-end lines and omits radar calibration + scan; other driver cited | Approve repair with adjustments + subrogation |
| CLM-24822 | Head-on into a pole, airbags, frame rails; repair ≈ 172% of ACV | Total loss evaluation |
| CLM-24830 | Windshield crack, full-glass $0 deductible, camera calibration | Fast-track payment |
| CLM-24835 | Parking-lot hit-and-run 8 days after inception, prior loss on VIN, damage-age indicators, **prompt-injection text in the claimant statement** | SIU referral |
| CLM-24841 | Driver is a named excluded driver | Coverage review |
| CLM-24846 | T-bone, curtain airbag, passenger to ER | Escalate injury (+ subrogation) |
| CLM-24852 | Hail, PDR, fully supported | Approve repair |
| CLM-24858 | Liability-only policy, insured backed into a parked car | Deny first-party (third-party PD covered) |

Verdicts, totals and ratios are computed by the MCP tools, not by the model; the system prompt tells the model to quote
them. The API drops citations to evidence that does not exist and flags runs that did not use both servers.

## Bedrock Knowledge Base (claims-handling manual)

Stack `ClaimsWb-KnowledgeBase`: `docs/kb/claims-manual/CHM-xxx.md` (synthetic manual, 29 sections, one document each, chunking NONE) → S3 → Bedrock
KB `claims-handling-manual` (Titan Text Embeddings V2, 1024 dims) → Amazon S3 Vectors. The agent's
`knowledge_base__search_guidelines` tool (Bedrock `Retrieve`) adds manual passages as evidence next to the MCP facts.
CDK starts ingestion when the docs change; `scripts/kb_sync.py` waits for it and tests retrieval (`--force` re-ingests).

## Model routing: switch the LLM at run time (AWS AppConfig)

Workbench page **Model routing** (`/models`): three linked sliders (quality / cost / latency, always 100%, starting
50/25/25) rank eight Bedrock LLMs from six providers (Anthropic, Amazon, OpenAI, Meta, MiniMax, DeepSeek); **Evaluate & apply** stores the preferences in AppConfig (`claims-workbench` /
`live` / `model-selection`) and, if another model wins by at least the switch margin and meets the quality floor,
routes live analyses to it within seconds, with no redeploy. The header chip shows the model serving now.

| Candidate | Bedrock id | Benchmark quality | $ / analysis | s / analysis |
|---|---|---|---|---|
| Claude Opus 4.6 | `us.anthropic.claude-opus-4-6-v1` | 95.6 | 0.235 | 64 |
| Claude Sonnet 4.6 (initial) | `us.anthropic.claude-sonnet-4-6` | 100.0 | 0.161 | 74 |
| Claude Haiku 4.5 | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | 97.8 | 0.037 | 37 |
| Amazon Nova 2 Lite | `us.amazon.nova-2-lite-v1:0` | 93.1 | 0.013 | 21 |
| OpenAI gpt-oss-120b | `openai.gpt-oss-120b-1:0` | 91.2 | 0.006 | 26 |

Quality 100% → Sonnet, cost 100% → gpt-oss, latency 100% → Nova 2 Lite, default 50/25/25 → Haiku (so the first
"Evaluate & apply" moves the app off Sonnet). Rebuild the catalog (prices from the AWS Price List API + a graded
benchmark of the real task on all 8 claims) with `.venv/bin/python scripts/model_benchmark.py`, then deploy.

## Class Insights (separate app): https://insights.awsteach.com

A second, separate application that shows students how everything was designed and deployed and what it is doing right
now. The Workbench header and sign-in page link to it. Students sign in with the same class account, through the
shared Cognito pool and a separate app client.

- **Static site:** private S3 bucket behind its own CloudFront distribution, WAF web ACL (`claims-insights-web`),
  ACM certificate and Route 53 records. Stack `ClaimsInsights`.
- **Dynamic content:** two Lambda functions behind Function URLs that only CloudFront can call (via OAC):
  - `claims-insights-api`: knowledge file, live inventory (CloudFormation, AgentCore, Lambda, Cognito counts), logs
    explorer over 6 allow-listed log groups, LLM reasoning logs, metrics
  - `claims-insights-chat`: Bedrock ConverseStream with Claude Sonnet 4.6, adaptive thinking (reasoning streams to the
    browser) and the same data as read-only tools
- **Knowledge base:** `docs/knowledge/projectknowledge.md`. `scripts/publish_knowledge.py` regenerates its
  live-inventory section and uploads it to the private, versioned bucket `claims-insights-knowledge-<account>`. It runs
  at the end of every deploy, and the chatbot re-reads the file within 30 s.
  **Keep this file updated (including the change log) whenever functionality changes.**
- **Reasoning log:** both the Workbench agent and the chatbot use extended thinking and write `llm_prompt` (once per
  run) and `llm_call` (per model call: input, reasoning, output, tool calls) JSON lines to CloudWatch Logs.
- **No keys:** read-only IAM scoped to the class's stacks, log groups, runtimes and functions, and `redact()` on every
  response. The browser only ever holds the student's own Cognito token.
- **Tests:** `scripts/insights_smoke.py` (API + chat) and `scripts/insights_ui_check.py` (browser).

Class Insights **Costs** page: the cost of every individual LLM call of both apps (tokens × list price, logged as
`costUsd` on each `llm_call`), spend by model, per analysis and per chatbot answer; plus an AWS Cost Explorer summary
(whole account: month to date by service, LLM share, 14-day chart, forecast, `project`-tagged spend).

## Repository layout

```
mcp_servers/claims_policy/   server.py (FastMCP, stateless Streamable HTTP :8000/mcp), tools.py, data/claims.json, Dockerfile
mcp_servers/damage_repair/   same shape, data/damage.json
mcp_servers/tests/           pytest: business logic + real MCP protocol tests against both servers
services/api/src/            Lambda: router, Cognito auth, MCP client, SigV4 fetch, Bedrock agent loop, DynamoDB store
services/api/test/           node:test: agent loop against the real local MCP servers with a scripted model
web/                         React + Vite SPA (Claims Workbench)
insights-web/                React + Vite SPA (Class Insights)
services/insights/src/       Class Insights Lambdas: data API, chatbot, read-only tools, redaction
services/signup/             Cognito self-registration trigger
docs/knowledge/              projectknowledge.md (Class Insights knowledge base)
infra/                       CDK app: Foundation, McpRuntimes, Api, Web, Observability stacks
scripts/                     preflight, deploy, seed users, smoke test, UI check, MCP inspector, fallback capture, teardown
```

## Class runbook: credentials -> deploy -> unplug

1. **Before class (no AWS access needed):** `scripts/ready_check.sh` checks the toolchain and Docker arm64 emulation
   (re-registering it if a reboot cleared it), builds both arm64 images, then runs all tests, the typecheck, the web
   build and `cdk synth`.
2. **Credential handling (live):** sign in from your own terminal, for example with `aws login`, which issues
   temporary console-session credentials. `aws configure sso` or `aws configure` also work. Keys should never be
   pasted into a chat. Then run `.venv/bin/python scripts/credentials_check.py`. It shows the credential source,
   the masked key id, whether the credentials are temporary or long-lived, when they expire, and which identity they
   map to. It confirms the account matches `cdk.json` and that the CDK CLI (Node SDK) and the AWS CLI resolve the same
   identity. It never prints a secret.
3. **Step 0: Claude 5.x activation:** `.venv/bin/python scripts/enable_models.py` creates the model agreements for
   every Anthropic Claude 5.x model in the region and proves each one with a live Converse call. Use `--dry-run` to
   report only.
4. **Deploy:** `scripts/deploy.sh` (repeats steps 2-3, then preflight, then deploy).
5. **Unplug:** `scripts/verify_independence.py` checks that nothing deployed points back at this workstation:
   - the Lambda environment has no local addresses or keys, and the MCP servers are reached by AgentCore runtime
     ARNs, not URLs
   - both runtimes are READY with images in this account's ECR
   - CloudFront origins are AWS only, and Cognito sign-in returns only to the public site
   - the downloaded JS has no local addresses, and public DNS and `/api/health` work

   The deploy credentials are never given to the app, which runs on its own IAM roles. You can sign out, delete the
   key, or shut this machine down, and the site keeps working.

## Deploy

Prerequisites (verified by `scripts/preflight.sh`): AWS credentials for the target account, Docker able to build
`linux/arm64` (`docker run --privileged --rm tonistiigi/binfmt --install arm64`), Node 22+, the Route 53 hosted zone
`awsteach.com` in the account with no existing `www` record, and Bedrock access to the model in `cdk.json`.

```bash
npm ci
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt && .venv/bin/playwright install chromium
scripts/preflight.sh          # read-only checks; reports blockers honestly
scripts/deploy.sh             # tests -> web build -> own bootstrap (ClaimsWb-CDKToolkit) -> 5 stacks -> users -> smoke test
.venv/bin/python scripts/ui_check.py          # headless browser walkthrough of the deployed site
.venv/bin/python scripts/seed_users.py --show # print demo passwords
```

Settings live in `cdk.json` → `context.workbench` (region, hostname, `modelId`, `alarmEmail`, `selfSignUp`). The app
uses its own CDK bootstrap qualifier (`claimswb`) so it never touches the account's shared `CDKToolkit`.

**Student accounts (self-registration).** On the sign-in page, a student chooses **Create an account** and enters:
- any username without spaces
- any password of at least 6 characters. That is Cognito's minimum, and there are no character-type rules.
- a **type of user**: *Claims analyst* (can run analyses) or *Claims supervisor* (can also approve, return or reject)

No email or verification code is needed. A Cognito trigger (`services/signup/handler.ts`) handles the rest:
- a pre-sign-up step confirms the account automatically and rejects an unknown user type
- a post-confirmation step adds the user to the group for the chosen type

Students can create as many accounts as they like, for example one of each type to play both sides of the approval.
Sign-ups through Cognito's own hosted page don't carry a type and default to analyst.

Instructor accounts (passwords generated into Secrets Manager `claims-workbench/demo-users/*`): `claims.analyst` and
`claims.supervisor`.

## Class demo script (~15 min)

1. **Prove the MCP requirement.** `scripts/mcp_inspect.py --runtimes` shows the two AgentCore runtime resources;
   `scripts/mcp_inspect.py` connects to each from your laptop with SigV4 and lists its tools. In the app, the **MCP
   servers** page does the same live from the API.
2. **Work queue → CLM-24817.** Every card on the claim page shows which server/tool supplied it.
3. **Run AI analysis.** Watch `tools/list` on both servers, parallel tool calls with evidence ids, then the
   `reconcile_estimate` call crossing the boundary. Click a citation chip to open the exact tool result.
4. **Approve** as `claims.supervisor` (the analyst gets a 403 - authorization is enforced server-side).
5. **Security moment:** CLM-24835's claimant statement tells "the AI" to skip checks. The agent flags it as a
   manipulation attempt and recommends SIU referral.
6. **Observability:** CloudWatch dashboard `claims-workbench` (analyses, tokens, per-tool latency from both the API and
   inside each runtime, audit log, WAF), plus AgentCore Observability traces for the runtimes.

**Reliability:** run `scripts/reset_runs.py` before class, then `scripts/smoke_test.py`. Record a fallback with
`scripts/capture_fallback.py CLM-24817 CLM-24835` and redeploy the web stack; the claim page then offers
**Replay recorded run** (clearly labeled, no live calls, approval disabled) if Bedrock or the network misbehaves.

## Local development

`scripts/local_dev.sh` runs both MCP servers (ports 8001/8002), the API (8787, auth bypassed, in-memory store) and Vite
(http://localhost:5173). Everything except **Run AI analysis** works offline; analysis needs Bedrock credentials.
Tests: `npm run test:py` (17), `npm test` (6), `npm run typecheck`, `(cd web && npm run build)`.

## Security summary

Cognito managed login (PKCE, no client secret) plus in-app self-registration. Training-demo settings: 6-character
passwords, auto-confirmed, no email, and the user picks their own role. Don't reuse these settings for real users.
Group-based authorization checked in the API; CloudFront with WAF
(IP reputation, known bad inputs, common rule set, per-IP rate limit), TLS 1.2+, CSP/HSTS headers; Lambda Function URL
with `AWS_IAM` reachable only via CloudFront OAC; MCP runtimes accept only SigV4 from the API role; least-privilege IAM
(one model, two runtimes, one table); DynamoDB encrypted with a customer-managed KMS key; demo passwords in Secrets
Manager; claimant text treated as untrusted; human approval required, first decision wins (conditional write), all
analyses/decisions audit-logged.

## Cost

Low and mostly per-use: Bedrock tokens per analysis (roughly 30-60k input tokens with prompt caching, a few thousand
output), AgentCore Runtime per active session second (sessions idle out after 10 minutes), Lambda, DynamoDB on-demand,
CloudFront. Fixed monthly items: WAF web ACL + 4 rules, KMS key, CloudWatch dashboard and alarms. Tear down after class.

## Teardown

```bash
scripts/teardown.sh --dry-run
scripts/teardown.sh --with-bootstrap
```

Deletes the 5 stacks, then what CloudFormation leaves behind (AgentCore runtime log groups, CDK helper log groups, the
ACM validation CNAME, demo-user secrets) and with `--with-bootstrap` the `ClaimsWb-CDKToolkit` stack, its retained
versioned asset bucket and ECR repository. Ends with a verification sweep. The KMS key remains PendingDeletion for 7 days.
