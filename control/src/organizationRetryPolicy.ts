
import type {
  OrganizationTestResult,
} from './organizationTestRunner';

export const MAX_ORGANIZATION_RETRIES = 3;

export type RetryDecision =
  | {
      action: 'retry';
      nextAttempt: number;
      maxAttempts: number;
      failedCommitSha: string;
      testResultId: string;
    }
  | {
      action: 'exhausted';
      attemptsUsed: number;
      maxAttempts: number;
      reason: string;
    }
  | {
      action: 'stop';
      reason: string;
    };

export interface RetryPolicyInput {
  projectId: string;
  testerWorkItemId: string;
  workspaceId: string;
  currentCommitSha: string;
  attemptsUsed: number;
  latestResult?: OrganizationTestResult;
}

export function planOrganizationRetry(
  input: RetryPolicyInput,
): RetryDecision {
  if (
    !Number.isInteger(input.attemptsUsed) ||
    input.attemptsUsed < 0
  ) {
    throw new Error('Invalid retry attempt count');
  }

  const result = input.latestResult;

  if (!result) {
    return {
      action: 'stop',
      reason: 'No recorded Tester result',
    };
  }

  if (
    result.projectId !== input.projectId ||
    result.workItemId !== input.testerWorkItemId ||
    result.taskId !==
      `org-work-${input.testerWorkItemId}` ||
    result.workspaceId !== input.workspaceId
  ) {
    return {
      action: 'stop',
      reason: 'Test result identity mismatch',
    };
  }

  if (
    !result.commitSha ||
    result.commitSha !== input.currentCommitSha
  ) {
    return {
      action: 'stop',
      reason: 'Test result commit is stale',
    };
  }

  if (result.status === 'passed') {
    return {
      action: 'stop',
      reason: 'Tests passed; retry is not required',
    };
  }

  if (
    result.status === 'timeout' ||
    result.status === 'invalid'
  ) {
    return {
      action: 'stop',
      reason: `Test infrastructure requires attention: ${result.status}`,
    };
  }

  if (
    result.status !== 'failed' ||
    result.exitCode === 0
  ) {
    return {
      action: 'stop',
      reason: 'No confirmed failing test execution',
    };
  }

  if (
    input.attemptsUsed >= MAX_ORGANIZATION_RETRIES
  ) {
    return {
      action: 'exhausted',
      attemptsUsed: input.attemptsUsed,
      maxAttempts: MAX_ORGANIZATION_RETRIES,
      reason:
        'Maximum automatic repair attempts reached',
    };
  }

  return {
    action: 'retry',
    nextAttempt: input.attemptsUsed + 1,
    maxAttempts: MAX_ORGANIZATION_RETRIES,
    failedCommitSha: result.commitSha,
    testResultId: result.id,
  };
}
