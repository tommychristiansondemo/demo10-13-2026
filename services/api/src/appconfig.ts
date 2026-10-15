// AWS AppConfig: the model catalog and the student-controlled model selection.
// Reads go through AppConfigData (a polling session per profile, cached in the Lambda instance for 15 s), so every
// Lambda instance picks up a change within seconds without a redeploy. Writes create a new hosted configuration version
// and deploy it with an instant (all-at-once, no bake) strategy; the AppConfig deployment history is the audit trail.
import {
  AppConfigClient,
  CreateHostedConfigurationVersionCommand,
  GetDeploymentCommand,
  ListDeploymentsCommand,
  StartDeploymentCommand,
} from '@aws-sdk/client-appconfig';
import { AppConfigDataClient, GetLatestConfigurationCommand, StartConfigurationSessionCommand } from '@aws-sdk/client-appconfigdata';
import bundledCatalog from '../../../config/model-catalog.json' with { type: 'json' };
import { config } from './config.js';
import { DEFAULT_WEIGHTS, type ModelCatalog, type ModelEntry, type ModelSelection } from './model-routing.js';

const data = new AppConfigDataClient({ region: config.region });
const control = new AppConfigClient({ region: config.region });
const POLL_MS = 15_000;

export const DEFAULT_SELECTION: ModelSelection = {
  weights: DEFAULT_WEIGHTS,
  activeModel: 'claude-sonnet-4-6',
  qualityFloor: 70,
  switchMargin: 1,
  updatedBy: 'deployment',
  updatedAt: '2026-10-14T00:00:00Z',
  reason: 'Initial configuration: quality 50%, cost 25%, latency 25%.',
};

const enabled = () => !!(config.appConfig.applicationId && config.appConfig.environmentId);

class ProfileReader<T> {
  private token?: string;
  private value?: T;
  private fetchedAt = 0;
  private inflight?: Promise<T>;
  constructor(
    private readonly profileId: string,
    private readonly fallback: T,
  ) {}

  get(): Promise<T> {
    if (!enabled() || !this.profileId) return Promise.resolve(this.value ?? this.fallback);
    if (this.value !== undefined && Date.now() - this.fetchedAt < POLL_MS) return Promise.resolve(this.value);
    return (this.inflight ??= this.poll().finally(() => (this.inflight = undefined)));
  }

  /** The writer already knows the new value; don't wait for the next poll in this instance. */
  set(v: T) {
    this.value = v;
    this.fetchedAt = Date.now();
  }

  private async poll(): Promise<T> {
    try {
      if (!this.token) {
        const s = await data.send(new StartConfigurationSessionCommand({
          ApplicationIdentifier: config.appConfig.applicationId, EnvironmentIdentifier: config.appConfig.environmentId,
          ConfigurationProfileIdentifier: this.profileId, RequiredMinimumPollIntervalInSeconds: 15,
        }));
        this.token = s.InitialConfigurationToken;
      }
      const r = await data.send(new GetLatestConfigurationCommand({ ConfigurationToken: this.token }));
      this.token = r.NextPollConfigurationToken;
      // An empty body means "unchanged since your last poll".
      if (r.Configuration && r.Configuration.length) this.value = JSON.parse(new TextDecoder().decode(r.Configuration)) as T;
      this.fetchedAt = Date.now();
    } catch (err) {
      this.token = undefined; // start a fresh session next time
      console.log(JSON.stringify({ log_type: 'appconfig_error', profileId: this.profileId, error: (err as Error).message }));
      if (this.value === undefined) return this.fallback; // degrade to the bundled default rather than fail the request
    }
    return this.value ?? this.fallback;
  }
}

const catalogReader = new ProfileReader<ModelCatalog>(config.appConfig.catalogProfileId, bundledCatalog as ModelCatalog);
const selectionReader = new ProfileReader<ModelSelection>(config.appConfig.selectionProfileId, DEFAULT_SELECTION);

export const getCatalog = () => catalogReader.get();
export const getSelection = () => selectionReader.get();

/** The model live traffic should use right now. */
export async function getActiveModel(): Promise<ModelEntry> {
  const [catalog, selection] = await Promise.all([getCatalog(), getSelection()]);
  return catalog.models.find((m) => m.key === selection.activeModel) ?? catalog.models.find((m) => m.key === DEFAULT_SELECTION.activeModel) ?? catalog.models[0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Store a new selection as a hosted configuration version and deploy it. Resolves when the deployment is COMPLETE. */
export async function saveSelection(next: ModelSelection, description: string): Promise<{ version: number; deploymentNumber: number; durationMs: number }> {
  const t0 = Date.now();
  if (!enabled()) {
    selectionReader.set(next);
    return { version: 0, deploymentNumber: 0, durationMs: 0 };
  }
  const { applicationId: ApplicationId, environmentId: EnvironmentId, selectionProfileId: ConfigurationProfileId, strategyId: DeploymentStrategyId } = config.appConfig;
  const desc = description.slice(0, 1024);
  const v = await control.send(new CreateHostedConfigurationVersionCommand({
    ApplicationId, ConfigurationProfileId, ContentType: 'application/json', Description: desc,
    Content: new TextEncoder().encode(JSON.stringify(next, null, 2)),
  }));
  // One deployment at a time per environment: if another student's change is still deploying, wait our turn.
  let deploymentNumber: number | undefined;
  for (let i = 0; deploymentNumber === undefined; i++) {
    try {
      const d = await control.send(new StartDeploymentCommand({
        ApplicationId, EnvironmentId, DeploymentStrategyId, ConfigurationProfileId, ConfigurationVersion: String(v.VersionNumber), Description: desc,
      }));
      deploymentNumber = d.DeploymentNumber!;
    } catch (err) {
      if ((err as Error).name !== 'ConflictException' || i >= 40) throw err;
      await sleep(750);
    }
  }
  for (let i = 0; i < 60; i++) {
    const d = await control.send(new GetDeploymentCommand({ ApplicationId, EnvironmentId, DeploymentNumber: deploymentNumber }));
    if (d.State === 'COMPLETE') break;
    if (d.State === 'ROLLED_BACK' || d.State === 'REVERTED') throw new Error(`AppConfig deployment ${deploymentNumber} ${d.State}`);
    await sleep(500);
  }
  selectionReader.set(next);
  return { version: v.VersionNumber!, deploymentNumber, durationMs: Date.now() - t0 };
}

/** Recent AppConfig deployments of the selection profile: who changed what, when. */
export async function selectionHistory(limit = 10) {
  if (!enabled()) return [];
  const r = await control.send(new ListDeploymentsCommand({ ApplicationId: config.appConfig.applicationId, EnvironmentId: config.appConfig.environmentId, MaxResults: 50 }));
  const items = (r.Items ?? []).filter((d) => d.ConfigurationName === 'model-selection').slice(0, limit);
  // The summary has no description (which carries who/what/why), so fetch each deployment.
  return Promise.all(
    items.map(async (d) => {
      const full = await control.send(new GetDeploymentCommand({ ApplicationId: config.appConfig.applicationId, EnvironmentId: config.appConfig.environmentId, DeploymentNumber: d.DeploymentNumber }));
      return { deploymentNumber: d.DeploymentNumber, version: d.ConfigurationVersion, state: d.State, startedAt: d.StartedAt?.toISOString(), completedAt: d.CompletedAt?.toISOString(), description: full.Description };
    }),
  );
}
