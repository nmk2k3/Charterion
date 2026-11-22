import type { AgentTask, SendAttemptRecord } from './contracts';
import {
  previewNativeOrganizationWebReview,
  decideNativeOrganizationWebReview,
  readNativeControlSnapshot,
  type NativeOrganizationReviewDecisionResult,
} from './nativeControl';
import { WEB_REVIEW_OPEN, WEB_REVIEW_CLOSE, parseWebReviewReply } from './organizationWebReviewProtocol';

const inflight = new Set<string>();

export interface WebReviewCompletionInput {
  attempt: SendAttemptRecord;
  task: AgentTask & { organizationWorkItemId?: unknown; projectId?: unknown };
  tabId: number;
  slotId: string;
  replyText: string;
}

export type WebReviewCompletionOutcome =
  | { status: 'ignored' | 'disabled' }
  | { status: 'decided'; result: NativeOrganizationReviewDecisionResult };

/** The native Kernel, never the assistant's prose, records Review Pool decisions. */
export async function completeOrganizationWebReview(
  input: WebReviewCompletionInput,
): Promise<WebReviewCompletionOutcome> {
  if (!input.replyText.includes(WEB_REVIEW_OPEN) && !input.replyText.includes(WEB_REVIEW_CLOSE)) {
    return { status: 'ignored' };
  }
  const { attempt, task, tabId, slotId } = input;
  if (attempt.taskId !== task.id || attempt.tabId !== tabId ||
      attempt.state !== 'reply-observed' || !task.attemptIds.includes(attempt.attemptId) ||
      !task.targetRole.startsWith('Review:') || task.completionPolicy !== 'structured-result' ||
      typeof task.organizationWorkItemId !== 'string') {
    throw new Error('Web Reviewer response has no durable matching task attempt');
  }
  if (inflight.has(attempt.attemptId)) return { status: 'ignored' };
  inflight.add(attempt.attemptId);
  try {
    const control = await readNativeControlSnapshot();
    const slot = control.agents.find((item) => item.id === slotId);
    if (!slot || slot.browserTabId !== tabId || slot.projectId !== task.projectId ||
        slot.role !== task.targetRole || slot.browserQuarantined ||
        slot.desiredState !== 'active' || slot.browserState !== 'open') {
      throw new Error('Web Reviewer tab is not the assigned AgentSlot');
    }
    const preview = await previewNativeOrganizationWebReview({
      projectId: slot.projectId, taskId: task.id, slotId, tabId,
    });
    if (!preview.reviewEnabled) return { status: 'disabled' };
    const parsed = parseWebReviewReply(input.replyText, {
      taskId: task.id, slotId,
      reviewSlotId: preview.reviewSlotId, headSha: preview.headSha,
    });
    if (parsed.kind !== 'ready') {
      throw new Error(parsed.kind === 'invalid'
        ? `Web Reviewer decision rejected: ${parsed.reason}`
        : 'Reviewer decision marker disappeared');
    }
    if (parsed.review.decision === 'approve' && !preview.diffComplete) {
      throw new Error('Truncated Git diff cannot authorize AI approval');
    }
    const result = await decideNativeOrganizationWebReview({
      projectId: slot.projectId, taskId: task.id, slotId, tabId,
      attemptId: attempt.attemptId, reviewSlotId: preview.reviewSlotId,
      headSha: preview.headSha, decision: parsed.review.decision,
      note: parsed.review.note,
    });
    if (result.projectId !== slot.projectId ||
        result.taskId !== task.id ||
        result.attemptId !== attempt.attemptId ||
        result.reviewSlotId !== preview.reviewSlotId) {
      throw new Error('Native Reviewer decision response identity is stale');
    }
    return { status: 'decided', result };
  } finally {
    inflight.delete(attempt.attemptId);
  }
}
