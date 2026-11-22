import type { AgentTask, ManagedTab } from './contracts';
import { provisionNativeTaskWorkspace, previewNativeOrganizationWebPatch, type NativeControlSnapshot } from './nativeControl';
import type { TaskWorkspacePromptContext } from './taskPrompt';

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
    return {
      ...workspace,
      patchEnabled: preview.patchEnabled,
      previewHeadSha: preview.headSha,
      sourceFiles: preview.files,
    };
  } catch {
    return workspace;
  }
}
