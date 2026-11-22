import type { AgentTask, SendAttemptRecord } from './contracts';
import {
  applyNativeOrganizationWebPatch,
  previewNativeOrganizationWebPatch,
  readNativeControlSnapshot,
  type NativeOrganizationWebPatchResult,
} from './nativeControl';
import { hasWebPatchMarkers, parseWebPatchReply } from './organizationWebPatchProtocol';

const inFlight = new Set<string>();

export interface WebPatchCompletionInput {
  attempt: SendAttemptRecord;
  task: AgentTask & { organizationWorkItemId?: unknown };
  tabId: number;
  slotId: string;
  replyText: string;
}

export type WebPatchCompletionOutcome =
  | { status: 'ignored' | 'disabled' }
  | { status: 'completed' | 'test-failed'; result: NativeOrganizationWebPatchResult };

/**
 * Text is treated solely as an untrusted patch proposal. This function does
 * not turn a ChatGPT Web reply into a verified claim; all durable authority
 * and Git checks are performed by the native Kernel.
 */
export async function completeOrganizationWebPatch(
  input: WebPatchCompletionInput,
): Promise<WebPatchCompletionOutcome> {
  if (!hasWebPatchMarkers(input.replyText)) {
    return { status: 'ignored' };
  }
  const { attempt, task, tabId, slotId } = input;
  if (!attempt.taskId || attempt.taskId !== task.id ||
      attempt.tabId !== tabId || attempt.state !== 'reply-observed' ||
      !task.attemptIds.includes(attempt.attemptId) ||
      task.kind !== 'work' || task.completionPolicy !== 'verified-claim' ||
      typeof task.organizationWorkItemId !== 'string' ||
      !['Developer','Tester'].includes(task.targetRole)) {
    throw new Error('Web patch reply has no matching durable Organization task attempt');
  }
  if (inFlight.has(attempt.attemptId)) return { status: 'ignored' };
  inFlight.add(attempt.attemptId);
  try {
    const snapshot = await readNativeControlSnapshot();
    const slot = snapshot.agents.find((candidate) => candidate.id === slotId);
    if (!slot || slot.browserTabId !== tabId || slot.projectId !== (task as AgentTask & { projectId?: unknown }).projectId ||
        slot.role !== task.targetRole || slot.browserQuarantined ||
        slot.desiredState !== 'active' || slot.browserState !== 'open') {
      throw new Error('Web patch reply does not match the active browser AgentSlot');
    }

    const preview = await previewNativeOrganizationWebPatch({
      projectId: slot.projectId,
      taskId: task.id,
      slotId: slot.id,
      tabId,
    });
    if (!preview.patchEnabled) return { status: 'disabled' };
    const parsed = parseWebPatchReply(input.replyText, {
      taskId: task.id, slotId: slot.id, baseSha: preview.headSha,
    });
    if (parsed.kind !== 'ready') {
      throw new Error(parsed.kind === 'invalid'
        ? `Web patch parser rejected response: ${parsed.reason}`
        : 'Web patch marker disappeared during processing');
    }
    if (task.targetRole === 'Developer' && parsed.patch.files.length === 0) {
      throw new Error('Developer Web patch must produce at least one changed source file');
    }
    const result = await applyNativeOrganizationWebPatch({
      projectId: slot.projectId,
      taskId: task.id,
      slotId: slot.id,
      tabId,
      attemptId: attempt.attemptId,
      baseSha: parsed.patch.baseSha,
      summary: parsed.patch.summary,
      files: parsed.patch.files,
    });
    if (result.attemptId !== attempt.attemptId || result.taskId !== task.id ||
        result.projectId !== slot.projectId) {
      throw new Error('Native Web patch result identity mismatch');
    }
    return { status: result.status, result };
  } finally {
    inFlight.delete(attempt.attemptId);
  }
}
