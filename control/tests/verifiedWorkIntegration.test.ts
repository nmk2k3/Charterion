
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
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
  it('accepts completion backed by a verified Git claim', () => {
    const dir = mkdtempSync(
      join(tmpdir(), 'verified-work-integration-'),
    );

    const repo = join(dir, 'repo');
    mkdirSync(repo);

    let db: ControlDatabase | undefined;

    try {
      // 1. Create a real Git repository.
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

      // 2. Create Kernel state.
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

      const developer = plane.organization.registerAgent({
        organizationId: org.id,
        displayName: 'Developer',
      });

      const workspaceConfig =
        plane.organization.activeAgentWorkspace(
          developer.id,
        )!;

      plane.organization.configureAgentWorkspace({
        workspaceId: workspaceConfig.id,
        rootRef: repo,
        browserProfileId: `browser-${developer.id}`,
        toolProfileRef: `tools-${developer.id}`,
      });

      const acquisition =
        plane.organizationRuntime.requestAndAcquire({
          organizationId: org.id,
          agentId: developer.id,
          projectId: project.id,
          role: 'Developer',
          idempotencyKey: 'verified-developer',
        });

      expect(acquisition.status).toBe('acquired');

      const mission = plane.organization.createMission({
        organizationId: org.id,
        projectId: project.id,
        title: 'Verified implementation',
        objective: 'Verify the result pipeline',
        driAgentId: developer.id,
      });

      plane.organization.setMissionStatus(
        mission.id,
        'active',
      );

      const work = plane.organization.createWorkItem({
        missionId: mission.id,
        title: 'Implement',
        objective: 'Produce a real Git commit',
        ownerAgentId: developer.id,
        completionPolicy: 'verified-claim',
      });

      plane.organization.setWorkStatus(
        work.id,
        'ready',
      );

      // 3. Project the execution task.
      const projection =
        plane.organizationExecution.materialize(work.id);

      const taskWorkspace =
        plane.provisionTaskWorkspace(
          project.id,
          acquisition.runtimeSlotId!,
          projection.managerTaskId,
        );

      expect(taskWorkspace.status).toBe('active');

      // 4. Make a real commit inside the assigned worktree.
      writeFileSync(
        join(taskWorkspace.path, 'result.txt'),
        'Verified integration result\n',
      );

      git(taskWorkspace.path, 'add', 'result.txt');
      git(
        taskWorkspace.path,
        'commit',
        '-m',
        'feat: add verified result',
      );

      const commitSha = git(
        taskWorkspace.path,
        'rev-parse',
        'HEAD',
      );

      // 5. Submit an evidence claim.
      const claim = plane.evidence.submitClaim({
        projectId: project.id,
        taskId: projection.managerTaskId,
        subject: acquisition.runtimeSlotId!,
        resourceId: taskWorkspace.resourceId,
        leaseEpoch: taskWorkspace.leaseEpoch,
        summary: 'Committed implementation',
        commitSha,
      });

      // 6. Verify using the real RPC path.
      const verificationResponse = router.handle({
        id: 'verify',
        method: 'claim.verify',
        auth: { adminToken: 'admin' },
        params: { claimId: claim.id },
      });

      expect(verificationResponse).toMatchObject({
        ok: true,
        result: {
          status: 'passed',
          claimId: claim.id,
        },
      });

      // 7. Assert machine completion was recorded.
      const executionTask = plane.work.getTask(
        projection.managerTaskId,
      );

      expect(executionTask?.machineCompletion).toMatchObject({
        kind: 'verified-claim',
        claimId: claim.id,
        commitSha,
      });

      // 8. Complete the Organization WorkItem.
      const completionResponse = router.handle({
        id: 'complete',
        method: 'org-work.complete',
        auth: { adminToken: 'admin' },
        params: {
          workItemId: work.id,
          completedBy: developer.id,
          summary: 'Verified implementation completed',
          producedRefs: [`commit:${commitSha}`],
        },
      });

      expect(completionResponse).toMatchObject({
        ok: true,
        result: {
          disposition: 'completed',
        },
      });

      expect(
        plane.organization.getWorkItem(work.id).status,
      ).toBe('completed');

      // 9. Completion must be idempotent.
      const replay = router.handle({
        id: 'complete-replay',
        method: 'org-work.complete',
        auth: { adminToken: 'admin' },
        params: {
          workItemId: work.id,
          completedBy: developer.id,
          summary: 'Verified implementation completed',
        },
      });

      expect(replay.ok).toBe(true);

      expect(
        plane.ingress.getOutcome(work.id),
      ).toBeDefined();
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
