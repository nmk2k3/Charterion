
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
      timeout: 15000,
      windowsHide: true,
      shell: false,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr ||
      result.error?.message ||
      'Git command failed',
    );
  }

  return result.stdout.trim();
}

describe('Organization Test Runner', () => {
  it('runs tests, records failures and preserves results', () => {
    const dir = mkdtempSync(
      join(tmpdir(), 'org-test-runner-'),
    );

    const repo = join(dir, 'repo');
    mkdirSync(repo);
    mkdirSync(join(repo, 'test'));

    let db: ControlDatabase | undefined;

    try {
      // 1. Build a real Node.js test repository.
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.name', 'Charterion Test');
      git(
        repo,
        'config',
        'user.email',
        'test@example.invalid',
      );

      writeFileSync(
        join(repo, 'sum.mjs'),
        'export const sum = (a, b) => a + b;\n',
      );

      writeFileSync(
        join(repo, 'test', 'sum.test.mjs'),
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { sum } from '../sum.mjs';",
          "test('sum works', () => {",
          "  assert.equal(sum(1, 2), 3);",
          "});",
          '',
        ].join('\n'),
      );

      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'initial test project');

      // 2. Configure Kernel and Tester.
      db = new ControlDatabase(join(dir, 'state.db'));

      const plane = new ControlPlane(db);
      const router = new RpcRouter(
        plane,
        'admin',
        'browser',
      );

      const project = plane.createProject({
        name: 'Test Project',
        rootPath: repo,
      });

      const org = plane.organization.createOrganization({
        name: 'Engineering',
      });

      const tester = plane.organization.registerAgent({
        organizationId: org.id,
        displayName: 'Tester',
      });

      const config =
        plane.organization.activeAgentWorkspace(
          tester.id,
        )!;

      plane.organization.configureAgentWorkspace({
        workspaceId: config.id,
        rootRef: repo,
        browserProfileId: `browser-${tester.id}`,
        toolProfileRef: `tools-${tester.id}`,
      });

      const acquisition =
        plane.organizationRuntime.requestAndAcquire({
          organizationId: org.id,
          agentId: tester.id,
          projectId: project.id,
          role: 'Tester',
          idempotencyKey: 'tester-runtime',
        });

      const mission = plane.organization.createMission({
        organizationId: org.id,
        projectId: project.id,
        title: 'Test mission',
        objective: 'Validate real test execution',
        driAgentId: tester.id,
      });

      plane.organization.setMissionStatus(
        mission.id,
        'active',
      );

      const work = plane.organization.createWorkItem({
        missionId: mission.id,
        title: 'Run tests',
        objective: 'Execute Node.js tests',
        ownerAgentId: tester.id,
        completionPolicy: 'verified-claim',
      });

      plane.organization.setWorkStatus(
        work.id,
        'ready',
      );

      const projection =
        plane.organizationExecution.materialize(work.id);

      const workspace = plane.provisionTaskWorkspace(
        project.id,
        acquisition.runtimeSlotId!,
        projection.managerTaskId,
      );

      // 3. Run the real test suite.
      const execute = (id: string, force = false) =>
        router.handle({
          id,
          method: 'org-test.run',
          auth: { adminToken: 'admin' },
          params: {
            projectId: project.id,
            workItemId: work.id,
            force,
          },
        });

      const denied = router.handle({
        id: 'denied',
        method: 'org-test.run',
        params: {
          projectId: project.id,
          workItemId: work.id,
        },
      });

      expect(denied.ok).toBe(false);

      const first = execute('first');

      expect(first).toMatchObject({
        ok: true,
        result: {
          status: 'passed',
          reused: false,
          exitCode: 0,
        },
      });

      // 4. Same commit should not run twice by default.
      const second = execute('second');

      expect(second).toMatchObject({
        ok: true,
        result: {
          status: 'passed',
          reused: true,
        },
      });

      const eventCount = db.db.prepare(`
        SELECT COUNT(*) AS count
        FROM events
        WHERE type = 'ORG_TEST_RUN_RECORDED'
          AND subject = ?
      `).get(projection.managerTaskId) as
        { count: number };

      expect(eventCount.count).toBe(1);

      // 5. Commit a real regression.
      writeFileSync(
        join(workspace.path, 'sum.mjs'),
        'export const sum = () => 99;\n',
      );

      git(workspace.path, 'add', 'sum.mjs');
      git(
        workspace.path,
        'commit',
        '-m',
        'test: introduce regression',
      );

      const newSha = git(
        workspace.path,
        'rev-parse',
        'HEAD',
      );

      // 6. A changed commit must be tested again.
      const failed = execute('failed');

      expect(failed).toMatchObject({
        ok: true,
        result: {
          status: 'failed',
          reused: false,
        },
      });

      if (failed.ok) {
        const result = failed.result as {
          commitSha: string;
        };

        expect(result.commitSha).toBe(newSha);
      }

      // 7. The latest result must be persisted.
      const latest = router.handle({
        id: 'latest',
        method: 'org-test.latest',
        auth: { adminToken: 'admin' },
        params: {
          projectId: project.id,
          workItemId: work.id,
        },
      });

      expect(latest).toMatchObject({
        ok: true,
        result: {
          status: 'failed',
          commitSha: newSha,
        },
      });

      // 8. Running tests never completes the WorkItem.
      expect(
        plane.organization.getWorkItem(work.id).status,
      ).toBe('ready');

      expect(
        plane.ingress.getOutcome(work.id),
      ).toBeUndefined();

      // 9. Dirty workspace must be rejected.
      writeFileSync(
        join(workspace.path, 'uncommitted.txt'),
        'Uncommitted change\n',
      );

      const dirty = execute('dirty');

      expect(dirty.ok).toBe(false);
    } finally {
      db?.close();
      rmSync(dir, {
        recursive: true,
        force: true,
      });
    }
  }, 45000);
});
