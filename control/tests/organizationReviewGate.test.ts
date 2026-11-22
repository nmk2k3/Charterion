
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
import { assertOrganizationReviewReady } from '../src/organizationReviewGate';

const gitPath = process.env.GAM_GIT_PATH || 'git';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    gitPath,
    ['-C', cwd, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 15000,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr ||
      result.error?.message ||
      `Git failed: ${args.join(' ')}`,
    );
  }

  return result.stdout.trim();
}

describe('Organization Reviewer Gate', () => {
  it('blocks Developer reviews and releases exact Tester evidence', () => {
    const dir = mkdtempSync(
      join(tmpdir(), 'organization-review-gate-'),
    );

    const repo = join(dir, 'repo');
    mkdirSync(repo);
    mkdirSync(join(repo, 'test'));

    let db: ControlDatabase | undefined;

    try {
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
          "test('sum', () => {",
          "  assert.equal(sum(1, 2), 3);",
          "});",
          '',
        ].join('\n'),
      );

      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'initial code');

      const initialSha = git(
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
        name: 'Reviewer Gate Sandbox',
        rootPath: repo,
        maxSlots: 12,
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
            idempotencyKey: `review-gate-${role}`,
          });

        return {
          agent,
          slotId: runtime.runtimeSlotId!,
        };
      }

      const developer = worker('Developer');
      const tester = worker('Tester');
      const reviewer = worker('Reviewer');

      const mission = plane.organization.createMission({
        organizationId: org.id,
        projectId: project.id,
        title: 'Implement and review',
        objective: 'Require passed Tester evidence',
        driAgentId: developer.agent.id,
      });

      plane.organization.setMissionStatus(
        mission.id,
        'active',
      );

      const devWork = plane.organization.createWorkItem({
        missionId: mission.id,
        title: 'Implement feature',
        objective: 'Create a verified feature commit',
        ownerAgentId: developer.agent.id,
        completionPolicy: 'verified-claim',
      });

      const testWork = plane.organization.createWorkItem({
        missionId: mission.id,
        title: 'Test feature',
        objective: 'Run real tests against Developer commit',
        ownerAgentId: tester.agent.id,
        completionPolicy: 'verified-claim',
        dependsOn: [devWork.id],
      });

      // Keep a Reviewer pending until Tester completes.
      const reviewWork = plane.organization.createWorkItem({
        missionId: mission.id,
        title: 'Final review',
        objective: 'Review the tested implementation',
        ownerAgentId: reviewer.agent.id,
        completionPolicy: 'verified-claim',
        dependsOn: [testWork.id],
      });

      plane.organization.setWorkStatus(
        devWork.id,
        'ready',
      );

      const devProjection =
        plane.organizationExecution.materialize(
          devWork.id,
        );

      const devWorkspace =
        plane.provisionTaskWorkspace(
          project.id,
          developer.slotId,
          devProjection.managerTaskId,
        );

      writeFileSync(
        join(devWorkspace.path, 'feature.txt'),
        'Implemented feature\n',
      );

      git(devWorkspace.path, 'add', 'feature.txt');
      git(
        devWorkspace.path,
        'commit',
        '-m',
        'feat: implement feature',
      );

      const devSha = git(
        devWorkspace.path,
        'rev-parse',
        'HEAD',
      );

      function verify(
        taskId: string,
        slotId: string,
        workspace: typeof devWorkspace,
      ) {
        const commitSha = git(
          workspace.path,
          'rev-parse',
          'HEAD',
        );

        const claim = plane.evidence.submitClaim({
          projectId: project.id,
          taskId,
          subject: slotId,
          resourceId: workspace.resourceId,
          leaseEpoch: workspace.leaseEpoch,
          summary: 'Verified Git commit',
          commitSha,
        });

        const response = router.handle({
          id: `verify-${taskId}`,
          method: 'claim.verify',
          auth: { adminToken: 'admin' },
          params: { claimId: claim.id },
        });

        expect(response).toMatchObject({
          ok: true,
          result: { status: 'passed' },
        });

        return claim;
      }

      function complete(
        workItemId: string,
        agentId: string,
      ) {
        const response = router.handle({
          id: `complete-${workItemId}`,
          method: 'org-work.complete',
          auth: { adminToken: 'admin' },
          params: {
            workItemId,
            completedBy: agentId,
            summary: 'Verified work completed',
          },
        });

        expect(response).toMatchObject({
          ok: true,
          result: { disposition: 'completed' },
        });
      }

      // 1. Developer's verified Git claim is not
      // sufficient to open code review.
      const devClaim = verify(
        devProjection.managerTaskId,
        developer.slotId,
        devWorkspace,
      );

      expect(
        db.db.prepare(`
          SELECT COUNT(*) AS count FROM review_requests
        `).get(),
      ).toMatchObject({ count: 0 });

      expect(() =>
        assertOrganizationReviewReady(
          db!,
          devProjection.managerTaskId,
          devClaim.id,
          devSha,
        ),
      ).toThrow(/Reviewer Gate/);

      // 2. Attempt to bypass through the public
      // ChangeRequest and ReviewPool authorities.
      const devChange = plane.changes.open({
        projectId: project.id,
        taskId: devProjection.managerTaskId,
        subject: developer.slotId,
        branch: devWorkspace.branch,
        targetBranch: 'main',
        baseSha: initialSha,
        headSha: devSha,
        claimId: devClaim.id,
      });

      expect(() =>
        plane.reviewPool.open({
          organizationId: org.id,
          changeRequestId: devChange.id,
          risk: 'normal',
          slots: [
            {
              dimension: 'correctness',
              required: true,
            },
          ],
        }),
      ).toThrow(/Reviewer Gate/);

      expect(() =>
        plane.changes.review({
          changeRequestId: devChange.id,
          reviewerSubject: reviewer.slotId,
          headSha: devSha,
          verdict: 'approve',
          body: 'Attempted early approval',
        }),
      ).toThrow(/Reviewer Gate/);

      // 3. Complete Developer Work.
      complete(devWork.id, developer.agent.id);

      expect(
        plane.organization.getWorkItem(
          testWork.id,
        ).status,
      ).toBe('ready');

      expect(
        plane.organization.getWorkItem(
          reviewWork.id,
        ).status,
      ).toBe('proposed');

      // 4. Tester receives exact Developer commit.
      const testTaskId = `org-work-${testWork.id}`;

      const testWorkspace =
        plane.provisionTaskWorkspace(
          project.id,
          tester.slotId,
          testTaskId,
        );

      expect(testWorkspace.baseSha).toBe(devSha);

      writeFileSync(
        join(testWorkspace.path, 'test-report.txt'),
        'Actual tests executed\n',
      );

      git(
        testWorkspace.path,
        'add',
        'test-report.txt',
      );

      git(
        testWorkspace.path,
        'commit',
        '-m',
        'test: record validation',
      );

      const testSha = git(
        testWorkspace.path,
        'rev-parse',
        'HEAD',
      );

      const testResult = new OrganizationTestRunner(
        plane,
      ).run(project.id, testWork.id);

      expect(testResult).toMatchObject({
        status: 'passed',
        exitCode: 0,
        commitSha: testSha,
      });

      const testClaim = verify(
        testTaskId,
        tester.slotId,
        testWorkspace,
      );

      // 5. PASS and claim verification are still
      // insufficient without org-work.complete.
      expect(() =>
        assertOrganizationReviewReady(
          db!,
          testTaskId,
          testClaim.id,
          testSha,
        ),
      ).toThrow(/Reviewer Gate/);

      const testChange = plane.changes.open({
        projectId: project.id,
        taskId: testTaskId,
        subject: tester.slotId,
        branch: testWorkspace.branch,
        targetBranch: 'main',
        baseSha: initialSha,
        headSha: testSha,
        claimId: testClaim.id,
      });

      expect(() =>
        plane.reviewPool.open({
          organizationId: org.id,
          changeRequestId: testChange.id,
          risk: 'normal',
          slots: [
            {
              dimension: 'correctness',
              required: true,
            },
          ],
        }),
      ).toThrow(/Reviewer Gate/);

      // 6. Only full Tester completion unlocks review.
      complete(testWork.id, tester.agent.id);

      expect(() =>
        assertOrganizationReviewReady(
          db!,
          testTaskId,
          testClaim.id,
          testSha,
        ),
      ).not.toThrow();

      // Developer's old Change Request remains blocked.
      expect(() =>
        plane.reviewPool.open({
          organizationId: org.id,
          changeRequestId: devChange.id,
          slots: [
            { dimension: 'correctness', required: true },
          ],
        }),
      ).toThrow(/Reviewer Gate/);

      // The exact Tester commit can now be reviewed.
      const allowed = plane.reviewPool.open({
        organizationId: org.id,
        changeRequestId: testChange.id,
        risk: 'normal',
        slots: [
          { dimension: 'correctness', required: true },
        ],
      });

      expect(allowed.status).toBe('open');
      expect(allowed.headSha).toBe(testSha);

      // Tester WorkOutcome already opened the durable Review Pool with two
      // required dimensions. Re-opening must reuse it, not replace the slot
      // policy requested by the Organization workflow.
      const slots = plane.reviewPool.listSlots(allowed.id);
      expect(slots).toHaveLength(2);
      expect(slots.every((slot) => slot.required)).toBe(true);
      expect(
        db!.db.prepare(
          'SELECT COUNT(*) AS count FROM review_requests WHERE change_request_id=?',
        ).get(testChange.id),
      ).toMatchObject({ count: 1 });

      expect(
        plane.organization.getWorkItem(
          reviewWork.id,
        ).status,
      ).toBe('ready');
    } finally {
      db?.close();

      rmSync(dir, {
        recursive: true,
        force: true,
      });
    }
  }, 90000);
});
