
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';
import { RpcRouter } from '../src/rpc';
import { OrganizationTestRunner } from '../src/organizationTestRunner';
import { OrganizationRetryController } from '../src/organizationRetryController';

import type {
  RetryRound,
} from '../src/organizationRetryController';

const gitPath = process.env.GAM_GIT_PATH || 'git';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function git(
  cwd: string,
  ...args: string[]
): string {
  const result = spawnSync(
    gitPath,
    ['-C', cwd, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      shell: false,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr ||
      result.error?.message ||
      `Git command failed: ${args.join(' ')}`,
    );
  }

  return result.stdout.trim();
}

function fixture() {
  const dir = mkdtempSync(
    join(tmpdir(), 'org-retry-lifecycle-'),
  );

  const repo = join(dir, 'repo');

  mkdirSync(repo);
  mkdirSync(join(repo, 'test'));

  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Charterion Test');
  git(
    repo,
    'config',
    'user.email',
    'test@example.invalid',
  );

  // The original implementation is broken.
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
      "test('sum works', () => {",
      "  assert.equal(sum(1, 2), 3);",
      "});",
      '',
    ].join('\n'),
  );

  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial failing code');

  const initialSha = git(repo, 'rev-parse', 'HEAD');

  const db = new ControlDatabase(
    join(dir, 'state.db'),
  );

  cleanups.push(() => {
    db.close();
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  });

  const plane = new ControlPlane(db);
  const router = new RpcRouter(
    plane,
    'admin',
    'browser',
  );

  const project = plane.createProject({
    name: 'Retry Lifecycle',
    rootPath: repo,
    maxSlots: 16,
  });

  const org = plane.organization.createOrganization({
    name: 'Engineering',
  });

  function worker(role: string) {
    const agent = plane.organization.registerAgent({
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

    if (!runtime.runtimeSlotId) {
      throw new Error(
        `${role} runtime was not acquired`,
      );
    }

    return {
      agentId: agent.id,
      slotId: runtime.runtimeSlotId,
    };
  }

  const developer = worker('Developer');
  const tester = worker('Tester');
  const reviewer = worker('Reviewer');

  const mission = plane.organization.createMission({
    organizationId: org.id,
    projectId: project.id,
    title: 'Repair lifecycle',
    objective:
      'Fix failing code, retest and then review',
    driAgentId: developer.agentId,
  });

  plane.organization.setMissionStatus(
    mission.id,
    'active',
  );

  const originalTester =
    plane.organization.createWorkItem({
      missionId: mission.id,
      title: 'Original Tester',
      objective: 'Detect the broken implementation',
      ownerAgentId: tester.agentId,
      completionPolicy: 'verified-claim',
    });

  const reviewWork =
    plane.organization.createWorkItem({
      missionId: mission.id,
      title: 'Final Reviewer',
      objective: 'Review only the passed result',
      ownerAgentId: reviewer.agentId,
      completionPolicy: 'verified-claim',
      dependsOn: [originalTester.id],
    });

  plane.organization.setWorkStatus(
    originalTester.id,
    'ready',
  );

  const projection =
    plane.organizationExecution.materialize(
      originalTester.id,
    );

  plane.provisionTaskWorkspace(
    project.id,
    tester.slotId,
    projection.managerTaskId,
  );

  const runner = new OrganizationTestRunner(plane);

  const initialFailure = runner.run(
    project.id,
    originalTester.id,
  );

  expect(initialFailure).toMatchObject({
    status: 'failed',
    commitSha: initialSha,
  });

  function requestRetry(failedTesterWorkItemId: string) {
    const response = router.handle({
      id: `retry-${failedTesterWorkItemId}`,
      method: 'org-retry.request',
      auth: { adminToken: 'admin' },
      params: {
        projectId: project.id,
        failedTesterWorkItemId,
        developerAgentId: developer.agentId,
      },
    });

    if (!response.ok) {
      throw new Error(response.error.message);
    }

    return response.result as {
      action: string;
      reused?: boolean;
      round?: RetryRound;
      attemptsUsed?: number;
    };
  }

  function createRetryRound(
    failedTesterWorkItemId: string,
  ): RetryRound {
    const response = requestRetry(
      failedTesterWorkItemId,
    );

    expect(response.action).toBe('created');
    expect(response.reused).toBe(false);
    expect(response.round).toBeDefined();

    return response.round!;
  }

  function provision(
    workItemId: string,
    slotId: string,
  ) {
    const taskId = `org-work-${workItemId}`;

    expect(
      plane.work.getTask(taskId),
    ).toBeDefined();

    return plane.provisionTaskWorkspace(
      project.id,
      slotId,
      taskId,
    );
  }

  function verifyAndComplete(
    workItemId: string,
    agentId: string,
    slotId: string,
    workspace: ReturnType<typeof provision>,
  ) {
    const commitSha = git(
      workspace.path,
      'rev-parse',
      'HEAD',
    );

    const claim = plane.evidence.submitClaim({
      projectId: project.id,
      taskId: `org-work-${workItemId}`,
      subject: slotId,
      resourceId: workspace.resourceId,
      leaseEpoch: workspace.leaseEpoch,
      summary: 'Real committed implementation',
      commitSha,
    });

    const verification = router.handle({
      id: `verify-${workItemId}`,
      method: 'claim.verify',
      auth: { adminToken: 'admin' },
      params: { claimId: claim.id },
    });

    expect(verification).toMatchObject({
      ok: true,
      result: {
        status: 'passed',
        claimId: claim.id,
      },
    });

    const completion = router.handle({
      id: `complete-${workItemId}`,
      method: 'org-work.complete',
      auth: { adminToken: 'admin' },
      params: {
        workItemId,
        completedBy: agentId,
        summary: 'Verified result completed',
        producedRefs: [`commit:${commitSha}`],
      },
    });

    expect(completion).toMatchObject({
      ok: true,
      result: {
        disposition: 'completed',
      },
    });

    expect(
      plane.organization.getWorkItem(workItemId).status,
    ).toBe('completed');

    return commitSha;
  }

  return {
    plane,
    project,
    mission,
    developer,
    tester,
    reviewWork,
    originalTester,
    initialSha,
    runner,
    requestRetry,
    createRetryRound,
    provision,
    verifyAndComplete,
  };
}

describe('Organization Retry Lifecycle', () => {
  it('runs FAILED -> Developer Fix -> Tester PASS', () => {
    const h = fixture();

    // 1. A real test failure creates repair round #1.
    const round = h.createRetryRound(
      h.originalTester.id,
    );

    expect(round.attemptNo).toBe(1);
    expect(round.failureSha).toBe(h.initialSha);

    expect(
      h.plane.organization.getWorkItem(
        h.originalTester.id,
      ).status,
    ).toBe('cancelled');

    // Reviewer must still be blocked.
    expect(
      h.plane.organization.getWorkItem(
        h.reviewWork.id,
      ).status,
    ).toBe('proposed');

    // 2. Developer starts from the failed commit.
    const developerWorkspace = h.provision(
      round.developerWorkItemId,
      h.developer.slotId,
    );

    expect(
      developerWorkspace.baseSha,
    ).toBe(h.initialSha);

    // Fix the actual bug.
    writeFileSync(
      join(developerWorkspace.path, 'sum.mjs'),
      'export const sum = (a, b) => a + b;\n',
    );

    git(developerWorkspace.path, 'add', 'sum.mjs');
    git(
      developerWorkspace.path,
      'commit',
      '-m',
      'fix: correct sum implementation',
    );

    const fixedSha = h.verifyAndComplete(
      round.developerWorkItemId,
      h.developer.agentId,
      h.developer.slotId,
      developerWorkspace,
    );

    expect(fixedSha).not.toBe(h.initialSha);

    // 3. Tester automatically receives the fix.
    expect(
      h.plane.organization.getWorkItem(
        round.testerWorkItemId,
      ).status,
    ).toBe('ready');

    const testerWorkspace = h.provision(
      round.testerWorkItemId,
      h.tester.slotId,
    );

    expect(
      testerWorkspace.baseSha,
    ).toBe(fixedSha);

    expect(
      git(testerWorkspace.path, 'rev-parse', 'HEAD'),
    ).toBe(fixedSha);

    // 4. Tester records its own evidence commit.
    writeFileSync(
      join(testerWorkspace.path, 'test-report.txt'),
      'Retest of fixed implementation\n',
    );

    git(
      testerWorkspace.path,
      'add',
      'test-report.txt',
    );

    git(
      testerWorkspace.path,
      'commit',
      '-m',
      'test: record passing retest',
    );

    const testedSha = git(
      testerWorkspace.path,
      'rev-parse',
      'HEAD',
    );

    const testResult = h.runner.run(
      h.project.id,
      round.testerWorkItemId,
    );

    expect(testResult).toMatchObject({
      status: 'passed',
      exitCode: 0,
      commitSha: testedSha,
    });

    // Reviewer must not be unlocked by test PASS alone.
    expect(
      h.plane.organization.getWorkItem(
        h.reviewWork.id,
      ).status,
    ).toBe('proposed');

    // 5. Verify Tester claim and complete the WorkItem.
    h.verifyAndComplete(
      round.testerWorkItemId,
      h.tester.agentId,
      h.tester.slotId,
      testerWorkspace,
    );

    // 6. Reviewer now depends on the successful Tester.
    const reviewer = h.plane.organization.getWorkItem(
      h.reviewWork.id,
    );

    expect(reviewer.dependsOn).toEqual([
      round.testerWorkItemId,
    ]);

    expect(reviewer.status).toBe('ready');

    expect(
      h.plane.work.getTask(
        `org-work-${h.reviewWork.id}`,
      ),
    ).toBeDefined();

    expect(
      new OrganizationRetryController(h.plane)
        .list(h.mission.id),
    ).toHaveLength(1);

    // Replay cannot create a second retry.
    const replay = h.requestRetry(
      h.originalTester.id,
    );

    expect(replay).toMatchObject({
      action: 'created',
      reused: true,
      round: {
        id: round.id,
      },
    });
  }, 120000);

  it('stops after three consecutive failed repair rounds', () => {
    const h = fixture();

    let currentTesterId = h.originalTester.id;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const round = h.createRetryRound(
        currentTesterId,
      );

      expect(round.attemptNo).toBe(attempt);

      const developerWorkspace = h.provision(
        round.developerWorkItemId,
        h.developer.slotId,
      );

      // Simulate a real commit that does not fix the bug.
      // Each round still produces a new verified commit.
      writeFileSync(
        join(
          developerWorkspace.path,
          `attempt-${attempt}.txt`,
        ),
        `Unsuccessful repair attempt ${attempt}\n`,
      );

      git(
        developerWorkspace.path,
        'add',
        `attempt-${attempt}.txt`,
      );

      git(
        developerWorkspace.path,
        'commit',
        '-m',
        `test: unsuccessful repair ${attempt}`,
      );

      const newSha = h.verifyAndComplete(
        round.developerWorkItemId,
        h.developer.agentId,
        h.developer.slotId,
        developerWorkspace,
      );

      const testerWorkspace = h.provision(
        round.testerWorkItemId,
        h.tester.slotId,
      );

      expect(testerWorkspace.baseSha).toBe(newSha);

      const failed = h.runner.run(
        h.project.id,
        round.testerWorkItemId,
      );

      expect(failed).toMatchObject({
        status: 'failed',
        commitSha: newSha,
      });

      currentTesterId = round.testerWorkItemId;
    }

    // No fourth repair round may be created.
    const exhausted = h.requestRetry(
      currentTesterId,
    );

    expect(exhausted).toMatchObject({
      action: 'exhausted',
      attemptsUsed: 3,
      maxAttempts: 3,
    });

    const rounds = new OrganizationRetryController(
      h.plane,
    ).list(h.mission.id);

    expect(rounds).toHaveLength(3);

    // Reviewer is still waiting for the latest Tester.
    const reviewWork =
      h.plane.organization.getWorkItem(
        h.reviewWork.id,
      );

    expect(reviewWork.status).toBe('proposed');
    expect(reviewWork.dependsOn).toEqual([
      currentTesterId,
    ]);

    expect(
      h.plane.work.getTask(
        `org-work-${h.reviewWork.id}`,
      ),
    ).toBeUndefined();

    expect(
      h.plane.ingress.getOutcome(currentTesterId),
    ).toBeUndefined();
  }, 120000);
});
