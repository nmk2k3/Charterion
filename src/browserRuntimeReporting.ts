import { readNativeControlSnapshot, reportNativeAgentRuntime, reportNativeIncident } from './nativeControl';
import type { ChatSnapshot, ContentObservationIdentity, RoleBinding } from './contracts';

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function reportIncident(
  code: string,
  subject: string,
  detail: Record<string, unknown>,
  severity: 'warning' | 'error' | 'critical' = 'error',
): Promise<void> {
  try {
    await reportNativeIncident({ scope: 'browser-extension', severity, code, subject, detail });
  } catch {
    // Incident transport failures cannot recursively report themselves.
  }
}

export async function reportSlotRuntime(
  tabId: number,
  observation: ContentObservationIdentity,
  snapshot: ChatSnapshot,
  resolveBinding: (tabId: number, snapshot: ChatSnapshot) => Promise<RoleBinding>,
): Promise<RoleBinding> {
  const binding = await resolveBinding(tabId, snapshot);
  if (!binding.agentSlotId) return binding;
  const control = await readNativeControlSnapshot();
  const slot = control.agents.find((agent) => agent.id === binding.agentSlotId);
  if (!slot) throw new Error('Assigned AgentSlot is missing from Kernel control state');
  if (slot.workspaceBrowserProfileId && slot.browserProfileId &&
      slot.workspaceBrowserProfileId !== slot.browserProfileId) {
    throw new Error('Organization workspace and AgentSlot browser profile disagree');
  }
  await reportNativeAgentRuntime({
    slotId: binding.agentSlotId,
    profileId: slot.workspaceBrowserProfileId ?? slot.browserProfileId ?? 'gam-default',
    tabId,
    contentEpoch: observation.contentEpoch,
    revision: observation.revision,
    pageStatus: snapshot.status,
    semanticSignature: observation.semanticSignature,
    observedAt: observation.observedAt,
  });
  return binding;
}
