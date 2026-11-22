import { ensureAdminToken, ensureBrowserToken, resolveDaemonConfig } from './config';
import { ControlDatabase } from './database';
import { ControlPlane } from './controlPlane';
import { OrganizationAutonomyScheduler } from './organizationAutonomyScheduler';
import { startIpcServer } from './ipc';
import { RpcRouter } from './rpc';

async function main(): Promise<void> {
  const config = resolveDaemonConfig();
  const adminToken = ensureAdminToken(config);
  const browserToken = ensureBrowserToken(config);
  const database = new ControlDatabase(config.databasePath);
  const plane = new ControlPlane(database, config.gitPath);
  const recoveredOrganizationWorkflows = plane.reconcilePersistedOrganizationWorkflows();
  if (recoveredOrganizationWorkflows > 0) console.error(`gamd recovered organization workflows=${recoveredOrganizationWorkflows}`);
  const router = new RpcRouter(plane, adminToken, browserToken, config.instanceId);
  const server = await startIpcServer(config.pipeName, router);

  let closing = false;
  // The scheduler only converges durable Kernel state. It never executes
  // repository tests, shells, or browser actions on its own.
  const scheduler = new OrganizationAutonomyScheduler(plane);
  const rawInterval = Number(process.env.GAM_AUTONOMY_POLL_MS ?? 15_000);
  const pollMs = Number.isInteger(rawInterval) && rawInterval >= 5000 && rawInterval <= 600_000
    ? rawInterval : 15_000;
  const tick = (): void => {
    if (closing || process.env.GAM_DISABLE_AUTONOMY === '1') return;
    for (const project of plane.listProjects().filter((item) => item.status === 'active')) {
      try {
        const result = scheduler.tick(project.id);
        if (result.retryCreated.length || result.exhausted.length || result.reviewReleased.length || result.projectedTaskIds.length) {
          console.error(`gamd autonomy project=${project.id} retries=${result.retryCreated.length} exhausted=${result.exhausted.length} reviews=${result.reviewReleased.length} projected=${result.projectedTaskIds.length}`);
        }
      } catch (error) {
        console.error('gamd autonomy tick failed', project.id, error);
      }
    }
  };
  const autonomyTimer = setInterval(tick, pollMs);
  autonomyTimer.unref();
  tick();

  const close = (): void => {
    if (closing) return;
    closing = true;
    clearInterval(autonomyTimer);
    server.close(() => {
      database.close();
    });
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  process.on('uncaughtException', (error) => {
    console.error(error);
    close();
  });
  console.error(`gamd ready instance=${config.instanceId} pipe=${config.pipeName}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
