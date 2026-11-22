
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';
import { RpcRouter } from '../src/rpc';
import { OrganizationTestRunner } from '../src/organizationTestRunner';

const gitPath = process.env.GAM_GIT_PATH || 'git';
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

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

function fixture(
  completionPolicy: 'verified-claim' | 'structured-result' =
    'verified-claim',
) {
  const dir = mkdtempSync(
    join(tmpdir(), 'tester-result-gate-'),
  );

  const repo = join(dir, 'repo');
  mkdirSync(repo);
  mkdirSync(join(repo, 'test'));

  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Charterion Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');

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

  const db = new ControlDatabase(join(dir, 'state.db'));

  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const plane = new ControlPlane(db);
  const router = new RpcRouter(plane, 'admin', 'browser');

  const project = plane.createProject({
    name: 'Result Gate Project',
    rootPath: repo,
    maxSlots: 8,
  });

  const org = plane.organization.createOrganization({
    name: 'Engineering',
  });

  const tester = plane.organization.registerAgent({
    organizationId: org.id,
    displayName: 'Tester',
  });

  const config =
    plane.organization.activeAgentWorkspace(tester.id)!;

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
    title: 'Verify Tester result',
    objective: 'Require passed tests for an exact commit',
    driAgentId: tester.id,
  });

  plane.organization.setMissionStatus(mission.id, 'active');

  const work = plane.organization.createWorkItem({
    missionId: mission.id,
    title: 'Validate implementation',
    objective: 'Run real tests and report the result',
    ownerAgentId: tester.id,
    completionPolicy,
  });

  plane.organization.setWorkStatus(work.id, 'ready');

  const projection =
    plane.organizationExecution.materialize(work.id);

  const workspace =
    completionPolicy === 'verified-claim'
      ? plane.provisionTaskWorkspace(
          project.id,
          acquisition.runtimeSlotId!,
          projection.managerTaskId,
        )
      : undefined;

  const runner = new OrganizationTestRunner(plane);

  function commitChange(broken = false) {
    if (!workspace) {
      throw new Error('Verified workspace is required');
    }

    if (broken) {
      writeFileSync(
        join(workspace.path, 'sum.mjs'),
        'export const sum = () => 99;\n',
      );
      git(workspace.path, 'add', 'sum.mjs');
    } else {
      writeFileSync(
        join(workspace.path, 'result.txt'),
        'Implementation result\n',
      );
      git(workspace.path, 'add', 'result.txt');
    }

    git(
      workspace.path,
      'commit',
      '-m',
      broken
        ? 'test: introduce regression'
        : 'feat: add implementation result',
    );

    return git(workspace.path, 'rev-parse', 'HEAD');
  }

  function runTests() {
    return runner.run(project.id, work.id);
  }

  function verifyCommit() {
    if (!workspace) {
      throw new Error('Verified workspace is required');
    }

    const commitSha = git(
      workspace.path,
      'rev-parse',
      'HEAD',
    );

    const claim = plane.evidence.submitClaim({
      projectId: project.id,
      taskId: projection.managerTaskId,
      subject: acquisition.runtimeSlotId!,
      resourceId: workspace.resourceId,
      leaseEpoch: workspace.leaseEpoch,
      summary: 'Tester evidence',
      commitSha,
    });

    const verification = router.handle({
      id: 'verify',
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

    return commitSha;
  }

  function complete() {
    return router.handle({
      id: 'complete',
      method: 'org-work.complete',
      auth: { adminToken: 'admin' },
      params: {
        workItemId: work.id,
        completedBy: tester.id,
        summary: 'Tester validation completed',
      },
    });
  }

  return {
    plane,
    project,
    work,
    runner,
    commitChange,
    runTests,
    verifyCommit,
    complete,
  };
}

describe('Organization Test Result Gate', () => {
  it('accepts a passed test matching the verified commit', () => {
    const h = fixture();

    const commitSha = h.commitChange();

    const testResult = h.runTests();

    expect(testResult).toMatchObject({
      status: 'passed',
      exitCode: 0,
      commitSha,
    });

    expect(h.verifyCommit()).toBe(commitSha);

    const completion = h.complete();

    expect(completion).toMatchObject({
      ok: true,
      result: {
        disposition: 'completed',
      },
    });

    expect(
      h.plane.organization.getWorkItem(h.work.id).status,
    ).toBe('completed');

    expect(h.complete().ok).toBe(true);
  }, 30000);

  it('rejects completion without a test result', () => {
    const h = fixture();

    h.commitChange();
    h.verifyCommit();

    const completion = h.complete();

    expect(completion.ok).toBe(false);

    if (!completion.ok) {
      expect(completion.error.message)
        .toMatch(/No recorded test execution/);
    }

    expect(
      h.plane.organization.getWorkItem(h.work.id).status,
    ).not.toBe('completed');
  }, 30000);

  it('rejects a failed test even when Git verification passed', () => {
    const h = fixture();

    h.commitChange(true);

    expect(h.runTests().status).toBe('failed');

    h.verifyCommit();

    const completion = h.complete();

    expect(completion.ok).toBe(false);

    if (!completion.ok) {
      expect(completion.error.message)
        .toMatch(/Latest test execution did not pass/);
    }

    expect(
      h.plane.ingress.getOutcome(h.work.id),
    ).toBeUndefined();
  }, 30000);

  it('rejects a PASS from a different commit', () => {
    const h = fixture();

    // PASS on the original repository commit.
    expect(h.runTests().status).toBe('passed');

    // Then create a new commit without retesting.
    h.commitChange();

    h.verifyCommit();

    const completion = h.complete();

    expect(completion.ok).toBe(false);

    if (!completion.ok) {
      expect(completion.error.message)
        .toMatch(/Tested commit differs from verified commit/);
    }
  }, 30000);

  it('rejects structured-result completion for Tester', () => {
    const h = fixture('structured-result');

    const completion = h.complete();

    expect(completion.ok).toBe(false);

    if (!completion.ok) {
      expect(completion.error.message)
        .toMatch(/Tester requires verified-claim/);
    }

    expect(
      h.plane.organization.getWorkItem(h.work.id).status,
    ).toBe('ready');
  }, 30000);
});
