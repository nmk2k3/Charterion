
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';
import { RpcRouter } from '../src/rpc';

const gitPath = process.env.GAM_GIT_PATH || 'git';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    gitPath,
    ['-C', cwd, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr ||
      result.error?.message ||
      `git ${args.join(' ')} failed`,
    );
  }

  return result.stdout.trim();
}

describe('Verified Work Integration', () => {
  it('passes the exact verified Developer commit to Tester', () => {
    const dir = mkdtempSync(
      join(tmpdir(), 'verified-work-integration-'),
    );

    const repo = join(dir, 'repo');
    mkdirSync(repo);

    let db: ControlDatabase | undefined;

    try {
      // ==========================================
      // 1. Initialize a real Git repository
      // ==========================================

      git(repo, 'init', '-b', 'main');

      git(repo, 'config', 'user.name', 'Charterion Test');
      git(
        repo,
        'config',
        'user.email',
        'test@example.invalid',
      );

      writeFileSync(
        join(repo, 'README.md'),
        'Initial project\n',
      );

      git(repo, 'add', 'README.md');
      git(repo, 'commit', '-m', 'initial commit');

      const initialSha = git(repo, 'rev-parse', 'HEAD');

      // ==========================================
      // 2. Initialize Kernel
      // ==========================================

      db = new ControlDatabase(join(dir, 'state.db'));

      const plane = new ControlPlane(db);

      const router = new RpcRouter(
        plane,
        'admin',
        'browser',
      );

      const project = plane.createProject({
        name: 'Verified Sandbox',
        rootPath: repo,
        maxSlots: 8,
      });

      const org = plane.organization.createOrganization({
        name: 'Engineering',
      });

      // ==========================================
      // 3. Create Developer
      // ==========================================

      const developer = plane.organization.registerAgent({
        organizationId: org.id,
        displayName: 'Developer',
      });

      const developerConfig =
        plane.organization.activeAgentWorkspace(
          developer.id,
        )!;

      plane.organization.configureAgentWorkspace({
        workspaceId: developerConfig.id,
        rootRef: repo,
        browserProfileId: `browser-${developer.id}`,
        toolProfileRef: `tools-${developer.id}`,
      });

      const developerAcquisition =
        plane.organizationRuntime.requestAndAcquire({
          organizationId: org.id,
          agentId: developer.id,
          projectId: project.id,
          role: 'Developer',
          idempotencyKey: 'verified-developer',
        });

      expect(developerAcquisition.status).toBe('acquired');

      // ==========================================
      // 4. Create Tester
      // ==========================================

      const tester = plane.organization.registerAgent({
        organizationId: org.id,
        displayName: 'Tester',
      });

      const testerConfig =
        plane.organization.activeAgentWorkspace(
          tester.id,
        )!;

      plane.organization.configureAgentWorkspace({
        workspaceId: testerConfig.id,
        rootRef: repo,
        browserProfileId: `browser-${tester.id}`,
        toolProfileRef: `tools-${tester.id}`,
      });

      const testerAcquisition =
        plane.organizationRuntime.requestAndAcquire({
          organizationId: org.id,
          agentId: tester.id,
          projectId: project.id,
          role: 'Tester',
          idempotencyKey: 'verified-tester',
        });

      expect(testerAcquisition.status).toBe('acquired');

      // ==========================================
      // 5. Create Mission
      // ==========================================

      const mission = plane.organization.createMission({
        organizationId: org.id,
        projectId: project.id,
        title: 'Verified implementation',
        objective:
          'Verify Developer-to-Tester commit handoff',
        driAgentId: developer.id,
      });

      plane.organization.setMissionStatus(
        mission.id,
        'active',
      );

      // ==========================================
      // 6. Create Developer WorkItem
      // ==========================================

      const devWork = plane.organization.createWorkItem({
        missionId: mission.id,
        title: 'Implement',
        objective: 'Produce a real Git commit',
        ownerAgentId: developer.id,
        completionPolicy: 'verified-claim',
      });

      // ==========================================
      // 7. Create dependent Tester WorkItem
      // ==========================================

      const testWork = plane.organization.createWorkItem({
        missionId: mission.id,
        title: 'Test implementation',
        objective:
          'Test the exact verified Developer commit',
        ownerAgentId: tester.id,
        completionPolicy: 'verified-claim',
        dependsOn: [devWork.id],
      });

      // Tester cannot start before Developer completes.
      expect(() =>
        plane.organization.setWorkStatus(
          testWork.id,
          'ready',
        ),
      ).toThrow(/incomplete dependency/);

      // ==========================================
      // 8. Prepare Developer execution
      // ==========================================

      plane.organization.setWorkStatus(
        devWork.id,
        'ready',
      );

      const developerProjection =
        plane.organizationExecution.materialize(
          devWork.id,
        );

      const developerWorkspace =
        plane.provisionTaskWorkspace(
          project.id,
          developerAcquisition.runtimeSlotId!,
          developerProjection.managerTaskId,
        );

      expect(developerWorkspace.status).toBe('active');

      expect(developerWorkspace.baseSha).toBe(initialSha);

      // ==========================================
      // 9. Developer creates a real Git commit
      // ==========================================

      writeFileSync(
        join(developerWorkspace.path, 'result.txt'),
        'Verified integration result\n',
      );

      git(
        developerWorkspace.path,
        'add',
        'result.txt',
      );

      git(
        developerWorkspace.path,
        'commit',
        '-m',
        'feat: add verified result',
      );

      const commitSha = git(
        developerWorkspace.path,
        'rev-parse',
        'HEAD',
      );

      expect(commitSha).not.toBe(initialSha);

      // ==========================================
      // 10. Developer submits evidence claim
      // ==========================================

      const claim = plane.evidence.submitClaim({
        projectId: project.id,
        taskId: developerProjection.managerTaskId,
        subject: developerAcquisition.runtimeSlotId!,
        resourceId: developerWorkspace.resourceId,
        leaseEpoch: developerWorkspace.leaseEpoch,
        summary: 'Committed implementation',
        commitSha,
      });

      expect(claim.status).toBe('submitted');

      // ==========================================
      // 11. Kernel verifies the claim
      // ==========================================

      const verificationResponse = router.handle({
        id: 'verify-developer',
        method: 'claim.verify',
        auth: {
          adminToken: 'admin',
        },
        params: {
          claimId: claim.id,
        },
      });

      expect(verificationResponse).toMatchObject({
        ok: true,
        result: {
          status: 'passed',
          claimId: claim.id,
        },
      });

      // ==========================================
      // 12. Verify machine completion
      // ==========================================

      const developerTask = plane.work.getTask(
        developerProjection.managerTaskId,
      );

      expect(
        developerTask?.machineCompletion,
      ).toMatchObject({
        kind: 'verified-claim',
        claimId: claim.id,
        commitSha,
      });

      // ==========================================
      // 13. Complete Developer WorkItem
      // ==========================================

      const completionResponse = router.handle({
        id: 'complete-developer',
        method: 'org-work.complete',
        auth: {
          adminToken: 'admin',
        },
        params: {
          workItemId: devWork.id,
          completedBy: developer.id,
          summary: 'Verified implementation completed',
          producedRefs: [`commit:${commitSha}`],
        },
      });

      expect(completionResponse).toMatchObject({
        ok: true,
        result: {
          disposition: 'completed',
          reconciliation: {
            status: 'ok',
          },
        },
      });

      expect(
        plane.organization.getWorkItem(devWork.id).status,
      ).toBe('completed');

      // ==========================================
      // 14. Tester should become ready automatically
      // ==========================================

      const testerTaskId = `org-work-${testWork.id}`;

      expect(
        plane.organization.getWorkItem(testWork.id).status,
      ).toBe('ready');

      const testerTask = plane.work.getTask(testerTaskId);

      expect(testerTask).toMatchObject({
        id: testerTaskId,
        targetRole: 'Tester',
        completionPolicy: 'verified-claim',
        organizationWorkItemId: testWork.id,
        dependsOn: [
          developerProjection.managerTaskId,
        ],
      });

      // ==========================================
      // 15. Provision Tester's workspace
      // ==========================================

      const testerWorkspace =
        plane.provisionTaskWorkspace(
          project.id,
          testerAcquisition.runtimeSlotId!,
          testerTaskId,
        );

      expect(testerWorkspace.status).toBe('active');

      // ==========================================
      // 16. Verify exact Developer commit handoff
      // ==========================================

      // The Tester must start from Developer's
      // verified commit, not the original main HEAD.

      expect(testerWorkspace.baseSha).toBe(commitSha);

      const testerHeadSha = git(
        testerWorkspace.path,
        'rev-parse',
        'HEAD',
      );

      expect(testerHeadSha).toBe(commitSha);
      expect(testerHeadSha).not.toBe(initialSha);

      // Verify the committed file is present
      // in Tester's actual worktree.

      const resultContent = readFileSync(
        join(testerWorkspace.path, 'result.txt'),
        'utf8',
      );

      expect(resultContent.replace(/\r\n/g, '\n')).toBe(
        'Verified integration result\n',
        );

      // Verify the same content through Git.
      expect(
        git(
          testerWorkspace.path,
          'show',
          'HEAD:result.txt',
        ),
      ).toBe('Verified integration result');

      // ==========================================
      // 17. Check idempotent Developer completion
      // ==========================================

      const revisionBeforeReplay =
        plane.work.snapshot().revision;

      const replay = router.handle({
        id: 'complete-developer-replay',
        method: 'org-work.complete',
        auth: {
          adminToken: 'admin',
        },
        params: {
          workItemId: devWork.id,
          completedBy: developer.id,
          summary: 'Verified implementation completed',
        },
      });

      expect(replay.ok).toBe(true);

      expect(
        plane.work.snapshot().revision,
      ).toBe(revisionBeforeReplay);

      expect(
        plane.ingress.getOutcome(devWork.id),
      ).toBeDefined();

      // ==========================================
      // 18. Confirm Tester still requires verification
      // ==========================================

      expect(
        plane.organization.getWorkItem(testWork.id).status,
      ).toBe('ready');

      expect(
        plane.ingress.getOutcome(testWork.id),
      ).toBeUndefined();

    } finally {
      db?.close();

      rmSync(dir, {
        recursive: true,
        force: true,
      });
    }
  }, 30000);
});
