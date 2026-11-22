
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
import { OrganizationTestRunner } from '../src/organizationTestRunner';
import { OrganizationRetryController } from '../src/organizationRetryController';

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
      'Git command failed',
    );
  }

  return result.stdout.trim();
}

describe('Durable Organization Retry Controller', () => {
  it('creates one retry and preserves Reviewer dependencies', () => {
    const dir = mkdtempSync(
      join(tmpdir(), 'organization-retry-'),
    );

    const repo = join(dir, 'repo');
    mkdirSync(repo);
    mkdirSync(join(repo, 'test'));

    let db: ControlDatabase | undefined;

    try {
      // Create a repository with a real failing test.
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.name', 'Retry Test');
      git(
        repo,
        'config',
        'user.email',
        'test@example.invalid',
      );

      writeFileSync(
        join(repo, 'sum.mjs'),
        'export const sum = () => 99;\n',
      );

      writeFileSync(
        join(repo, 'test', 'sum.test.mjs'),
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { sum } from '../sum.mjs';",
          "test('sum', () => {",
          "  assert.equal(sum(1, 2), 3);",
          "});",
          '',
        ].join('\n'),
      );

      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'failing implementation');

      const failedSha = git(
        repo,
        'rev-parse',
        'HEAD',
      );

      db = new ControlDatabase(
        join(dir, 'state.db'),
      );

      const plane = new ControlPlane(db);
      const router = new RpcRouter(
        plane,
        'admin',
        'browser',
      );

      const project = plane.createProject({
        name: 'Retry Sandbox',
        rootPath: repo,
        maxSlots: 8,
      });

      const org = plane.organization.createOrganization({
        name: 'Engineering',
      });

      function worker(role: string) {
        const agent =
          plane.organization.registerAgent({
            organizationId: org.id,
            displayName: role,
          });

        const config =
          plane.organization.activeAgentWorkspace(
            agent.id,
          )!;

        plane.organization.configureAgentWorkspace({
          workspaceId: config.id,
          rootRef: repo,
          browserProfileId: `browser-${agent.id}`,
          toolProfileRef: `tools-${agent.id}`,
        });

        const runtime =
          plane.organizationRuntime.requestAndAcquire({
            organizationId: org.id,
            agentId: agent.id,
            projectId: project.id,
            role,
            idempotencyKey: `runtime-${role}`,
          });

        return { agent, runtime };
      }

      const developer = worker('Developer');
      const tester = worker('Tester');
      const reviewer = worker('Reviewer');

      const mission = plane.organization.createMission({
        organizationId: org.id,
        projectId: project.id,
        title: 'Repair a regression',
        objective: 'Fix, retest and review',
        driAgentId: developer.agent.id,
      });

      plane.organization.setMissionStatus(
        mission.id,
        'active',
      );

      const failedTester =
        plane.organization.createWorkItem({
          missionId: mission.id,
          title: 'Original test',
          objective: 'Find the regression',
          ownerAgentId: tester.agent.id,
          completionPolicy: 'verified-claim',
        });

      const reviewWork =
        plane.organization.createWorkItem({
          missionId: mission.id,
          title: 'Review final implementation',
          objective: 'Review only a passed result',
          ownerAgentId: reviewer.agent.id,
          completionPolicy: 'verified-claim',
          dependsOn: [failedTester.id],
        });

      plane.organization.setWorkStatus(
        failedTester.id,
        'ready',
      );

      const projection =
        plane.organizationExecution.materialize(
          failedTester.id,
        );

      const testerWorkspace =
        plane.provisionTaskWorkspace(
          project.id,
          tester.runtime.runtimeSlotId!,
          projection.managerTaskId,
        );

      // Run actual failing tests.
      const result = new OrganizationTestRunner(
        plane,
      ).run(project.id, failedTester.id);

      expect(result.status).toBe('failed');
      expect(result.commitSha).toBe(failedSha);

      const request = () => router.handle({
        id: 'retry',
        method: 'org-retry.request',
        auth: { adminToken: 'admin' },
        params: {
          projectId: project.id,
          failedTesterWorkItemId: failedTester.id,
          developerAgentId: developer.agent.id,
        },
      });

      const first = request();

      expect(first).toMatchObject({
        ok: true,
        result: {
          action: 'created',
          reused: false,
          round: {
            attemptNo: 1,
            failureSha: failedSha,
            testResultId: result.id,
          },
        },
      });

      if (!first.ok) {
        throw new Error(first.error.message);
      }

      const created = first.result as {
        round: {
          developerWorkItemId: string;
          testerWorkItemId: string;
          id: string;
        };
      };

      // Old Tester is superseded, not completed.
      expect(
        plane.organization.getWorkItem(
          failedTester.id,
        ).status,
      ).toBe('cancelled');

      expect(
        plane.ingress.getOutcome(failedTester.id),
      ).toBeUndefined();

      // Old Kernel task cannot be dispatched again.
      expect(
        plane.work.getTask(
          projection.managerTaskId,
        ),
      ).toMatchObject({
        cancelledAt: expect.any(Number),
      });

      // Reviewer now waits for the new Tester.
      expect(
        plane.organization.getWorkItem(
          reviewWork.id,
        ).dependsOn,
      ).toEqual([
        created.round.testerWorkItemId,
      ]);

      // New Tester waits for new Developer.
      expect(
        plane.organization.getWorkItem(
          created.round.testerWorkItemId,
        ).dependsOn,
      ).toEqual([
        created.round.developerWorkItemId,
      ]);

      // Reconciliation should have projected Developer Fix.
      const fixTaskId =
        `org-work-${created.round.developerWorkItemId}`;

      expect(
        plane.work.getTask(fixTaskId),
      ).toBeDefined();

      // The fix starts from the exact failing commit.
      const fixWorkspace =
        plane.provisionTaskWorkspace(
          project.id,
          developer.runtime.runtimeSlotId!,
          fixTaskId,
        );

      expect(fixWorkspace.baseSha).toBe(failedSha);
      expect(
        git(fixWorkspace.path, 'rev-parse', 'HEAD'),
      ).toBe(failedSha);

      // Replaying the request must not create new work.
      const second = request();

      expect(second).toMatchObject({
        ok: true,
        result: {
          action: 'created',
          reused: true,
          round: {
            id: created.round.id,
          },
        },
      });

      const rounds = new OrganizationRetryController(
        plane,
      ).list(mission.id);

      expect(rounds).toHaveLength(1);

      // Persisted retry survives opening another DB instance.
      const reopened = new ControlDatabase(
        join(dir, 'state.db'),
      );

      try {
        const recovered = new ControlPlane(reopened);
        const persisted =
          new OrganizationRetryController(
            recovered,
          ).list(mission.id);

        expect(persisted).toHaveLength(1);
        expect(persisted[0]?.id)
          .toBe(created.round.id);
      } finally {
        reopened.close();
      }

      // Failure workspace is intentionally preserved
      // for traceable source commit handoff.
      expect(testerWorkspace.status).toBe('active');
    } finally {
      db?.close();
      rmSync(dir, {
        recursive: true,
        force: true,
      });
    }
  }, 60000);
});
