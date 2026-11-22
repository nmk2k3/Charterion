import { markReplyObserved, workState } from './backgroundWorkState';
import { snapshotSemanticKey } from './chatgptAdapter';
import { recoveryStateForTab } from './contentRuntimeBridge';
import { canRecoverAcknowledgedReplyAcrossEpochs } from './recovery';
import type { ChatSnapshot } from './contracts';

/**
 * Reconcile one observed reply against its durable send attempt.
 * Cross-epoch recovery is intentionally restricted to Organization work and
 * requires an independent live content-state probe, original session delivery
 * evidence and an advanced assistant-message baseline. Never resend here.
 */
export async function acknowledgeObservedReply(
  attemptId: string,
  tabId: number,
  currentEpoch: string,
  snapshot: ChatSnapshot,
): Promise<boolean> {
  const state = await workState();
  const attempt = state.attempts.find((item) => item.attemptId === attemptId);
  if (!attempt || attempt.tabId !== tabId) return false;
  if (attempt.contentEpoch === currentEpoch) {
    return markReplyObserved(attemptId, currentEpoch, snapshot, tabId);
  }
  if (!attempt.taskId?.startsWith('org-work-')) return false;

  const live = await recoveryStateForTab({ id: tabId });
  if (!live || live.state.observation.contentEpoch !== currentEpoch ||
      live.state.observation.semanticSignature !== snapshotSemanticKey(snapshot) ||
      !canRecoverAcknowledgedReplyAcrossEpochs(attempt, live)) return false;

  // markReplyObserved retains the original browser-operation epoch and id.
  // Only the already-acknowledged attempt is advanced; there is no new send.
  return markReplyObserved(attempt.attemptId, attempt.contentEpoch, snapshot, tabId);
}
