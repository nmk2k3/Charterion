import { workState } from './backgroundWorkState';
import { completeOrganizationWebPatch } from './organizationWebPatchCompletion';
import { hasWebPatchMarkers } from './organizationWebPatchProtocol';
import { completeOrganizationWebReview } from './organizationWebReviewCompletion';
import type { ManagedTab, SendAttemptRecord } from './contracts';

export interface ObservedOrganizationWebReply {
  attemptId: string;
  tabId: number;
  slotId: string | undefined;
  replyText: string;
}

export async function processObservedOrganizationWebReply(
  input: ObservedOrganizationWebReply,
  onChanged: () => Promise<void>,
): Promise<void> {
  if (!input.slotId) return;
  const state = await workState();
  const attempt = state.attempts.find((item) => item.attemptId === input.attemptId);
  const task = state.tasks.find((item) => item.id === attempt?.taskId);
  if (!attempt || !task || task.machineCompletion || task.cancelledAt) return;

  // Replies are untrusted proposals. These adapters invoke native Kernel
  // authorities; a model response alone cannot complete a WorkItem.
  const patch = await completeOrganizationWebPatch({
    attempt, task, tabId: input.tabId, slotId: input.slotId,
    replyText: input.replyText,
  });
  const review = await completeOrganizationWebReview({
    attempt, task, tabId: input.tabId, slotId: input.slotId,
    replyText: input.replyText,
  });
  if (patch.status === 'completed' || patch.status === 'test-failed' ||
      review.status === 'decided') {
    await onChanged();
  }
}

export interface OrganizationWebReplyRecoveryOptions {
  managedTabs: (attempts: readonly SendAttemptRecord[]) => Promise<ManagedTab[]>;
  onChanged: () => Promise<void>;
  onBlocked: (attempt: SendAttemptRecord, error: unknown) => void;
}

/**
 * Replay only durable reply-observed attempts. Native exact-SHA and attempt
 * checks are authoritative; partially written worktrees require manual recovery.
 */
export async function recoverOrganizationWebReplies(
  options: OrganizationWebReplyRecoveryOptions,
): Promise<void> {
  const state = await workState();
  const candidates = state.attempts.filter((attempt) =>
    attempt.state === 'reply-observed' &&
    attempt.taskId?.startsWith('org-work-') &&
    (hasWebPatchMarkers(attempt.replyTextTail ?? '') ||
      attempt.replyTextTail?.includes('<<<CHARTERION_REVIEW_V1>>>')),
  );
  if (candidates.length === 0) return;

  const tabs = await options.managedTabs(state.attempts);
  for (const attempt of candidates) {
    const tab = tabs.find((candidate) =>
      candidate.tabId === attempt.tabId && Boolean(candidate.binding.agentSlotId));
    if (!tab?.binding.agentSlotId) continue;

    try {
      await processObservedOrganizationWebReply({
        attemptId: attempt.attemptId,
        tabId: tab.tabId,
        slotId: tab.binding.agentSlotId,
        replyText: attempt.replyTextTail ?? '',
      }, options.onChanged);
    } catch (error) {
      options.onBlocked(attempt, error);
    }
  }
}
