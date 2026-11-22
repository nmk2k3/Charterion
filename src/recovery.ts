import type {
  ContentRecoveryState,
  SendAttemptRecord,
  SendAttemptState,
} from './contracts';
import { hasNewAssistantReply } from './replyCorrelation';

export interface AttemptRecoveryObservation {
  tabId: number;
  state: ContentRecoveryState;
  authoritativeConversationKey?: string;
}

export interface AttemptRecoveryDecision {
  attemptId: string;
  nextState?: SendAttemptState;
  error?: string;
}

const SEND_STALE_MS = 2 * 60 * 1000;
const deliveredAttemptSets = new WeakMap<ContentRecoveryState, ReadonlySet<string>>();

function deliveredAttemptSet(state: ContentRecoveryState): ReadonlySet<string> {
  const cached = deliveredAttemptSets.get(state);
  if (cached) return cached;
  const indexed = new Set(state.deliveredAttemptIds);
  deliveredAttemptSets.set(state, indexed);
  return indexed;
}

function sameConversation(record: SendAttemptRecord, observation: AttemptRecoveryObservation): boolean {
  if (record.tabId !== observation.tabId || record.contentEpoch !== observation.state.observation.contentEpoch) return false;
  const observedKey = observation.state.snapshot.conversationKey;
  if (record.conversationKey === observedKey) return true;
  return record.conversationKey === 'url:https://chatgpt.com/' &&
    observedKey.startsWith('conversation:') && observation.authoritativeConversationKey === observedKey;
}

export function recoverAttempt(
  record: SendAttemptRecord,
  observation: AttemptRecoveryObservation | undefined,
  now = Date.now(),
): AttemptRecoveryDecision {
  if (record.state === 'reply-observed' || record.state === 'failed' || record.state === 'uncertain') {
    return { attemptId: record.attemptId };
  }
  if (record.state === 'prepared') {
    return {
      attemptId: record.attemptId,
      nextState: 'failed',
      error: 'Service worker restarted before browser dispatch; prompt was not sent',
    };
  }
  if (!observation || !sameConversation(record, observation)) {
    return {
      attemptId: record.attemptId,
      nextState: 'uncertain',
      error: 'Cannot safely reconstruct this browser delivery after extension restart',
    };
  }

  const pending = observation.state.pendingAttempt;
  const pendingMatches = pending?.attemptId === record.attemptId;
  const delivered = deliveredAttemptSet(observation.state).has(record.attemptId);

  if (record.state === 'dispatched') {
    if (pendingMatches && delivered) {
      return { attemptId: record.attemptId, nextState: 'acknowledged' };
    }
    if (pendingMatches && !delivered && now - pending.startedAt <= SEND_STALE_MS) {
      return { attemptId: record.attemptId };
    }
    return {
      attemptId: record.attemptId,
      nextState: 'uncertain',
      error: 'Dispatch started but durable page delivery evidence is incomplete after restart',
    };
  }

  if (record.state === 'acknowledged') {
    if (pendingMatches && delivered) return { attemptId: record.attemptId };
    return {
      attemptId: record.attemptId,
      nextState: 'uncertain',
      error: 'Prompt delivery was acknowledged but reply-correlation baseline is unavailable after restart',
    };
  }

  return { attemptId: record.attemptId };
}

/**
 * Accept an already-acknowledged Organization reply after an extension upgrade
 * only when the original tab's session-scoped pending+delivery evidence survives,
 * the durable attempt has exactly the same old content epoch and baseline,
 * and a fresh, directly observed assistant message has advanced that baseline.
 *
 * A provisional conversation key is allowed to become canonical: ChatGPT can
 * assign /c/<id> only after the first message has been sent. This path never
 * resends a prompt and does not claim task completion.
 */
export function canRecoverAcknowledgedReplyAcrossEpochs(
  record: SendAttemptRecord,
  observation: AttemptRecoveryObservation,
): boolean {
  if (record.state !== 'acknowledged' || record.tabId !== observation.tabId) return false;
  const { state } = observation;
  const pending = state.pendingAttempt;
  const currentEpoch = state.observation.contentEpoch;
  if (!currentEpoch || currentEpoch === record.contentEpoch ||
      !pending || pending.attemptId !== record.attemptId ||
      pending.contentEpoch !== record.contentEpoch ||
      !deliveredAttemptSet(state).has(record.attemptId)) return false;
  if (pending.baselineAssistantMessageCount !== record.baselineAssistantMessageCount ||
      pending.baselineAssistantMessageId !== record.baselineAssistantMessageId ||
      pending.startedAt < record.createdAt ||
      pending.startedAt > record.updatedAt + SEND_STALE_MS) return false;

  const next = state.snapshot;
  if (next.status !== 'idle' || next.confidence !== 'direct' ||
      !next.signals.includes('composer-ready') ||
      next.observedAt < pending.startedAt ||
      state.observation.observedAt !== next.observedAt ||
      !hasNewAssistantReply(next, {
        assistantMessageCount: record.baselineAssistantMessageCount,
        ...(record.baselineAssistantMessageId
          ? { latestAssistantMessageId: record.baselineAssistantMessageId }
          : {}),
      })) return false;

  try {
    if (new URL(next.url).origin !== 'https://chatgpt.com') return false;
  } catch { return false; }
  if (record.conversationKey.startsWith('conversation:')) {
    return next.conversationKey === record.conversationKey;
  }
  // A first-turn provisional identity belongs exclusively to this old
  // content generation; do not equate arbitrary provisional keys.
  return record.conversationKey === `provisional:${record.contentEpoch}` &&
    (next.conversationKey.startsWith('conversation:') ||
      next.conversationKey === `provisional:${currentEpoch}`);
}
