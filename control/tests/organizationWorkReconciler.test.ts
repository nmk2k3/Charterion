
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';
import { OrganizationWorkReconciler } from '../src/organizationWorkReconciler';

describe('Organization Work Reconciler', () => {
  it('unlocks dependent tasks and prevents duplicates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'work-reconcile-'));
    const db = new ControlDatabase(join(dir, 'state.db'));

    try {
      const plane = new ControlPlane(db);

      const project = plane.createProject({
        name: 'Sandbox',
        rootPath: dir,
        maxSlots: 4,
      });

      const org = plane.organization.createOrganization({
        name: 'Engineering',
      });

      function createWorker(role: string) {
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

      const developer = createWorker('Developer');
      const tester = createWorker('Tester');

      const mission = plane.organization.createMission({
        organizationId: org.id,
        projectId: project.id,
        title: 'Smoke Test',
        objective: 'Verify automatic work reconciliation',
        driAgentId: developer.id,
      });

      plane.organization.setMissionStatus(
        mission.id,
        'active',
      );

      const devWork = plane.organization.createWorkItem({
        missionId: mission.id,
        title: 'Implement',
        objective: 'Produce a simulated result',
        ownerAgentId: developer.id,
        completionPolicy: 'structured-result',
      });

      const testWork = plane.organization.createWorkItem({
        missionId: mission.id,
        title: 'Test',
        objective: 'Validate simulated result',
        ownerAgentId: tester.id,
        completionPolicy: 'structured-result',
        dependsOn: [devWork.id],
      });

      const reconciler =
        new OrganizationWorkReconciler(plane);

      // Developer is ready; Tester is blocked.
      const first = reconciler.reconcile(project.id);

      expect(first.projectedTaskIds).toEqual([
        `org-work-${devWork.id}`,
      ]);

      expect(first.blocked).toEqual([
        expect.objectContaining({
          workItemId: testWork.id,
        }),
      ]);

      // Replaying must not create duplicates.
      const revision = plane.work.snapshot().revision;

      expect(
        reconciler.reconcile(project.id).projectedTaskIds,
      ).toEqual([]);

      expect(plane.work.snapshot().revision)
        .toBe(revision);

      // Simulate Developer completion.
      // This is NOT real AI execution or test evidence.
      plane.ingress.completeWorkItem({
        workItemId: devWork.id,
        completedBy: developer.id,
        summary: 'Simulated completion for unit test',
      });

      // Tester becomes eligible.
      const second = reconciler.reconcile(project.id);

      expect(second.projectedTaskIds).toEqual([
        `org-work-${testWork.id}`,
      ]);

      expect(
        plane.organization.getWorkItem(testWork.id).status,
      ).toBe('ready');

      // Still idempotent.
      expect(
        reconciler.reconcile(project.id).projectedTaskIds,
      ).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
