
import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  planOrganizationRetry,
  MAX_ORGANIZATION_RETRIES,
} from '../src/organizationRetryPolicy';

import type {
  OrganizationTestResult,
} from '../src/organizationTestRunner';

const projectId = 'project-1';
const testerWorkItemId = 'tester-1';
const taskId = `org-work-${testerWorkItemId}`;
const workspaceId = 'workspace-1';
const commitSha = 'a'.repeat(40);

function result(
  status: OrganizationTestResult['status'],
): OrganizationTestResult {
  return {
    id: 'test-result-1',
    projectId,
    workItemId: testerWorkItemId,
    taskId,
    workspaceId,
    commitSha,
    suite: 'node:test',
    status,
    exitCode: status === 'passed' ? 0 : 1,
    durationMs: 100,
    stdout: '',
    stderr: '',
    createdAt: Date.now(),
  };
}

function plan(
  status: OrganizationTestResult['status'],
  attemptsUsed = 0,
) {
  return planOrganizationRetry({
    projectId,
    testerWorkItemId,
    workspaceId,
    currentCommitSha: commitSha,
    attemptsUsed,
    latestResult: result(status),
  });
}

describe('Organization Retry Policy', () => {
  it('schedules the first retry after FAILED', () => {
    expect(plan('failed', 0)).toMatchObject({
      action: 'retry',
      nextAttempt: 1,
      maxAttempts: 3,
      failedCommitSha: commitSha,
    });
  });

  it('allows exactly three repair attempts', () => {
    expect(MAX_ORGANIZATION_RETRIES).toBe(3);

    expect(plan('failed', 1)).toMatchObject({
      action: 'retry',
      nextAttempt: 2,
    });

    expect(plan('failed', 2)).toMatchObject({
      action: 'retry',
      nextAttempt: 3,
    });

    expect(plan('failed', 3)).toMatchObject({
      action: 'exhausted',
      attemptsUsed: 3,
    });
  });

  it('never retries a passed test', () => {
    expect(plan('passed', 0)).toMatchObject({
      action: 'stop',
      reason: expect.stringContaining('passed'),
    });
  });

  it('does not treat infrastructure errors as code failures', () => {
    expect(plan('timeout', 0).action).toBe('stop');
    expect(plan('invalid', 0).action).toBe('stop');
  });

  it('rejects test results from another commit', () => {
    const decision = planOrganizationRetry({
      projectId,
      testerWorkItemId,
      workspaceId,
      currentCommitSha: 'b'.repeat(40),
      attemptsUsed: 0,
      latestResult: result('failed'),
    });

    expect(decision).toMatchObject({
      action: 'stop',
      reason: 'Test result commit is stale',
    });
  });

  it('rejects a result from another Tester', () => {
    const decision = planOrganizationRetry({
      projectId,
      testerWorkItemId: 'another-tester',
      workspaceId,
      currentCommitSha: commitSha,
      attemptsUsed: 0,
      latestResult: result('failed'),
    });

    expect(decision).toMatchObject({
      action: 'stop',
      reason: 'Test result identity mismatch',
    });
  });

  it('rejects invalid retry counters', () => {
    expect(() =>
      plan('failed', -1),
    ).toThrow(/Invalid retry attempt count/);

    expect(() =>
      plan('failed', 1.5),
    ).toThrow(/Invalid retry attempt count/);
  });

  it('does not retry without a test result', () => {
    const decision = planOrganizationRetry({
      projectId,
      testerWorkItemId,
      workspaceId,
      currentCommitSha: commitSha,
      attemptsUsed: 0,
    });

    expect(decision.action).toBe('stop');
  });
});