
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-guard-'));
  const db = new ControlDatabase(join(dir, 'state.db'));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const plane = new ControlPlane(db);
  const project = plane.createProject({
    name: 'Sandbox',
    rootPath: dir,
  });
  const org = plane.organization.createOrganization({
    name: 'Test Organization',
  });
  const agent = plane.organization.registerAgent({
    organizationId: org.id,
    displayName: 'Test Worker',
  });

  const workspace = plane.organization.activeAgentWorkspace(agent.id)!;
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
    role: 'Developer',
    idempotencyKey: 'test-runtime',
  });

  const mission = plane.organization.createMission({
    organizationId: org.id,
    projectId: project.id,
    title: 'Test mission',
    objective: 'Test dependency enforcement',
    driAgentId: agent.id,
  });
  plane.organization.setMissionStatus(mission.id, 'active');

  const parent = plane.organization.createWorkItem({
    missionId: mission.id,
    title: 'Developer',
    objective: 'Implement',
    ownerAgentId: agent.id,
    completionPolicy: 'structured-result',
  });

  const child = plane.organization.createWorkItem({
    missionId: mission.id,
    title: 'Tester',
    objective: 'Validate implementation',
    ownerAgentId: agent.id,
    completionPolicy: 'structured-result',
    dependsOn: [parent.id],
  });

  return { plane, db, agent, parent, child };
}

describe('Work Dependency Guard', () => {
  it('blocks dependent work until its parent completes', () => {
    const { plane, agent, parent, child } = fixture();

    expect(() =>
      plane.organization.setWorkStatus(child.id, 'ready'),
    ).toThrow(/incomplete dependency/);

    expect(() =>
      plane.organization.setWorkStatus(child.id, 'active'),
    ).toThrow(/incomplete dependency/);

    expect(() =>
      plane.organization.setWorkStatus(child.id, 'completed'),
    ).toThrow(/incomplete dependency/);

    expect(() =>
      plane.ingress.completeWorkItem({
        workItemId: child.id,
        completedBy: agent.id,
        summary: 'Premature completion',
      }),
    ).toThrow(/incomplete dependency/);

    plane.organization.setWorkStatus(parent.id, 'ready');

    plane.ingress.completeWorkItem({
      workItemId: parent.id,
      completedBy: agent.id,
      summary: 'Test parent completed',
    });

    expect(
      plane.organization.setWorkStatus(child.id, 'ready').status,
    ).toBe('ready');
  });

  it('rejects execution projection if dependency is incomplete', () => {
    const { plane, db, child } = fixture();

    // Simulate a legacy invalid state to test defense in depth.
    db.db.prepare(
      "UPDATE organization_work_items SET status = 'ready' WHERE id = ?",
    ).run(child.id);

    expect(() =>
      plane.organizationExecution.materialize(child.id),
    ).toThrow(/incomplete dependency/);

    expect(
      plane.work.getTask(`org-work-${child.id}`),
    ).toBeUndefined();
  });
});
