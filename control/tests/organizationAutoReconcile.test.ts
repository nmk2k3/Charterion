
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';
import { RpcRouter } from '../src/rpc';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-reconcile-'));
  const db = new ControlDatabase(join(dir, 'state.db'));

  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const plane = new ControlPlane(db);
  const router = new RpcRouter(plane, 'admin', 'browser');

  const project = plane.createProject({
    name: 'Sandbox',
    rootPath: dir,
    maxSlots: 4,
  });

  const org = plane.organization.createOrganization({
    name: 'Engineering',
  });

  function worker(role: string) {
    const agent = plane.organization.registerAgent({
      organizationId: org.id,
      displayName: role,
    });

    const workspace =
      plane.organization.activeAgentWorkspace(agent.id)!;

    plane.organization.configureAgentWorkspace({
      workspaceId: workspace.id,
      rootRef: dir,
      browserProfileId: `browser-${agent.id}`,
      toolProfileRef: `tools-${agent.id}`,
    });

    plane.organizationRuntime.requestAndAcquire({
      organizationId: org.id,
      agentId: agent.id,
      projectId: project.id,
      role,
      idempotencyKey: `runtime-${role}`,
    });

    return agent;
  }

  const developer = worker('Developer');
  const tester = worker('Tester');

  const mission = plane.organization.createMission({
    organizationId: org.id,
    projectId: project.id,
    title: 'Workflow test',
    objective: 'Test automatic reconciliation',
    driAgentId: developer.id,
  });

  plane.organization.setMissionStatus(mission.id, 'active');

  const devWork = plane.organization.createWorkItem({
    missionId: mission.id,
    title: 'Implement',
    objective: 'Simulate implementation',
    ownerAgentId: developer.id,
    completionPolicy: 'structured-result',
  });

  const testWork = plane.organization.createWorkItem({
    missionId: mission.id,
    title: 'Test',
    objective: 'Validate implementation',
    ownerAgentId: tester.id,
    completionPolicy: 'structured-result',
    dependsOn: [devWork.id],
  });

  plane.organization.setWorkStatus(devWork.id, 'ready');
  plane.organizationExecution.materialize(devWork.id);

  const completeDeveloper = () =>
    router.handle({
      id: 'complete',
      method: 'org-work.complete',
      auth: { adminToken: 'admin' },
      params: {
        workItemId: devWork.id,
        completedBy: developer.id,
        summary: 'Simulated result for unit test',
      },
    });

  return {
    plane,
    project,
    devWork,
    testWork,
    completeDeveloper,
  };
}

describe('Automatic Organization Work Reconciliation', () => {
  it('projects Tester after Developer completion', () => {
    const h = fixture();

    const response = h.completeDeveloper();

    expect(response).toMatchObject({
      ok: true,
      result: {
        disposition: 'completed',
        reconciliation: {
          status: 'ok',
          projectedTaskIds: [
            `org-work-${h.testWork.id}`,
          ],
        },
      },
    });

    expect(
      h.plane.organization.getWorkItem(h.testWork.id).status,
    ).toBe('ready');

    expect(
      h.plane.work.getTask(`org-work-${h.testWork.id}`),
    ).toMatchObject({
      targetRole: 'Tester',
    });

    const revision = h.plane.work.snapshot().revision;

    const replay = h.completeDeveloper();

    expect(replay.ok).toBe(true);
    expect(h.plane.work.snapshot().revision)
      .toBe(revision);
  });

  it('preserves completion when reconciliation fails', () => {
    const h = fixture();

    h.plane.setProjectStatus(h.project.id, 'paused');

    const response = h.completeDeveloper();

    expect(response).toMatchObject({
      ok: true,
      result: {
        disposition: 'completed',
        reconciliation: {
          status: 'failed',
        },
      },
    });

    expect(
      h.plane.organization.getWorkItem(h.devWork.id).status,
    ).toBe('completed');

    expect(
      h.plane.work.getTask(`org-work-${h.testWork.id}`),
    ).toBeUndefined();
  });
});
