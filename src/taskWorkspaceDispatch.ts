import type { AgentTask, ManagedTab } from './contracts';
import { provisionNativeTaskWorkspace, previewNativeOrganizationWebPatch, previewNativeOrganizationWebReview, type NativeControlSnapshot, type NativeOrganizationReviewPreview } from './nativeControl';
import type { TaskWorkspacePromptContext } from './taskPrompt';
import { reportIncident } from './browserRuntimeReporting';

export async function provisionTaskWorkspaceForDispatch(
  task: AgentTask,
  tabId: number,
  tabs: readonly ManagedTab[],
  control: NativeControlSnapshot,
): Promise<TaskWorkspacePromptContext | undefined> {
  if (task.completionPolicy !== 'verified-claim') return undefined;
  const tab = tabs.find((item) => item.tabId === tabId);
  const slotId = tab?.binding.agentSlotId?.trim();
  if (!slotId) throw new Error(`Task ${task.id} dispatch tab has no durable AgentSlot binding`);
  const agent = control.agents.find((item) => item.id === slotId);
  if (!agent) throw new Error(`Task ${task.id} AgentSlot ${slotId} is missing from Kernel control state`);
  const workspace = await provisionNativeTaskWorkspace({ projectId: agent.projectId, slotId, taskId: task.id });
  // Web-patch previews are opt-in; a legacy/disabled host still dispatches
  // the normal scoped WorkItem prompt without pretending that it can write.
  if (typeof (task as AgentTask & { organizationWorkItemId?: unknown }).organizationWorkItemId !== 'string') {
    return workspace;
  }
  try {
    const preview = await previewNativeOrganizationWebPatch({
      projectId: agent.projectId, taskId: task.id, slotId, tabId,
    });
    if (!preview.patchEnabled) {
      await reportIncident('organization-web-patch-disabled', task.id, {
        tabId, slotId, reason: 'Kernel preview reports GAM_ALLOW_WEB_PATCHES disabled',
      }, 'warning');
    }
    return {
      ...workspace,
      patchEnabled: preview.patchEnabled,
      previewHeadSha: preview.headSha,
      sourceFiles: preview.files,
    };
  } catch (error) {
    await reportIncident('organization-web-patch-preview-unavailable', task.id, {
      tabId, slotId, error: error instanceof Error ? error.message : String(error),
    }, 'warning');
    // Preserve explicit manual-CLI fallback for installations that opt out
    // of native Web Patch. It must never be represented as patch capability.
    return workspace;
  }
}

/** Review Pool tasks have read-only diff access, never a writable worktree. */
export async function previewOrganizationReviewForDispatch(
  task: AgentTask,
  tabId: number,
  tabs: readonly ManagedTab[],
  control: NativeControlSnapshot,
): Promise<NativeOrganizationReviewPreview | undefined> {
  if (task.completionPolicy !== 'structured-result' || !task.targetRole.startsWith('Review:')) {
    return undefined;
  }
  const tab = tabs.find((item) => item.tabId === tabId);
  const slotId = tab?.binding.agentSlotId;
  if (!slotId) return undefined;
  const slot = control.agents.find((item) => item.id === slotId);
  if (!slot || slot.browserTabId !== tabId || slot.role !== task.targetRole) return undefined;
  try {
    return await previewNativeOrganizationWebReview({
      projectId: slot.projectId, taskId: task.id, slotId, tabId,
    });
  } catch {
    // Disabled or older Kernel: fall back to the original manual
    // structured review. No native approval is inferred from prose.
    return undefined;
  }
}
