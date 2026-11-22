import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';
import { RpcRouter } from '../src/rpc';

const cleanups: Array<() => void> = [];
function harness(): ControlPlane {
  const dir = mkdtempSync(join(tmpdir(), 'charterion-continuity-'));
  const database = new ControlDatabase(join(dir, 'global.db'));
  cleanups.push(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });
  return new ControlPlane(database);
}
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function configureWorkspace(plane: ControlPlane, agentId: string, now: number) {
  const workspace = plane.organization.activeAgentWorkspace(agentId)!;
  return plane.organization.configureAgentWorkspace({
    workspaceId: workspace.id,
    rootRef: `E:/agents/${agentId}`,
    browserProfileId: `browser-${agentId}`,
    toolProfileRef: `tools-${agentId}`,
    allowedRefs: ['E:/repo'],
    forbiddenRefs: ['E:/kernel'],
  }, now);
}
describe('persistent Organization Agent conversation continuity', () => {
  it('moves one canonical conversation across runtime slots without changing Agent identity', () => {
    const plane = harness();
    const project = plane.createProject({ name: 'Repo', rootPath: 'E:/repo', maxSlots: 2 }, 1);
    const first = plane.createAgentSlot(project.id, 'ENGINEER_A', 2);
    const second = plane.createAgentSlot(project.id, 'ENGINEER_B', 3);
    const org = plane.organization.createOrganization({ name: 'Company' }, 4);
    const agent = plane.organization.registerAgent({ organizationId: org.id, displayName: 'Engineer' }, 5);
    configureWorkspace(plane, agent.id, 6);

    plane.organization.bindRuntimeSlot(agent.id, first.id, 7);
    plane.bindAgentConversation(first.id, 'conversation:durable-a', 8);
    expect(plane.agentContinuity.active(agent.id)).toMatchObject({
      agentId: agent.id, generation: 1, conversationKey: 'conversation:durable-a', runtimeSlotId: first.id,
    });

    plane.organization.unbindRuntimeSlot(agent.id, 9);
    plane.organization.bindRuntimeSlot(agent.id, second.id, 10);
    const moved = plane.bindAgentConversation(second.id, 'conversation:durable-a', 11);
    expect(moved).toMatchObject({ conversationKey: 'conversation:durable-a', conversationGeneration: 1 });
    expect(plane.getAgentSlot(first.id).conversationKey).toBeUndefined();
    expect(plane.agentContinuity.active(agent.id)).toMatchObject({ runtimeSlotId: second.id, generation: 1 });
  });
  it('advances persistent generation only after verified rollover bootstrap', () => {
    const plane = harness();
    const project = plane.createProject({ name: 'Repo', rootPath: 'E:/repo' }, 1);
    const slot = plane.createAgentSlot(project.id, 'ENGINEER', 2);
    const org = plane.organization.createOrganization({ name: 'Company' }, 3);
    const agent = plane.organization.registerAgent({ organizationId: org.id, displayName: 'Engineer' }, 4);
    configureWorkspace(plane, agent.id, 5);
    plane.organization.bindRuntimeSlot(agent.id, slot.id, 6);
    plane.bindAgentConversation(slot.id, 'conversation:a', 7);

    const rollover = plane.requestAgentConversationRollover(slot.id, 'limit', 'continue same mission', {}, 8);
    plane.beginAgentConversationRollover(slot.id, rollover.id, 9);
    plane.reportAgentBrowser({ slotId: slot.id, profileId: `browser-${agent.id}`, browserState: 'opening', tabId: 10 }, 10);
    plane.reportAgentBrowser({ slotId: slot.id, profileId: `browser-${agent.id}`, browserState: 'open', tabId: 10, conversationKey: 'conversation:b' }, 11);
    expect(plane.agentContinuity.active(agent.id)).toMatchObject({ generation: 1, conversationKey: 'conversation:a' });

    plane.browser.planOperation({ id: 'bootstrap', idempotencyKey: 'bootstrap', operation: 'prompt.send', slotId: slot.id, preconditionsHash: 'hash' }, 12);
    plane.browser.dispatchOperation('bootstrap', 13);
    plane.markAgentRolloverBootstrap(slot.id, rollover.id, 'bootstrap', 14);
    expect(() => plane.completeAgentConversationRollover(slot.id, 'bootstrap', 15)).toThrow(/verified reply evidence/i);
    expect(plane.agentContinuity.active(agent.id)).toMatchObject({ generation: 1, conversationKey: 'conversation:a' });
    plane.browser.settleOperation('bootstrap', 'reply-observed', { assistantMessageId: 'm1' }, 16);
    plane.completeAgentConversationRollover(slot.id, 'bootstrap', 17);
    expect(plane.agentContinuity.active(agent.id)).toMatchObject({
      generation: 2,
      conversationKey: 'conversation:b',
      predecessorConversationKey: 'conversation:a',
      runtimeSlotId: slot.id,
    });
    expect(plane.agentContinuity.list(agent.id)).toMatchObject([
      { generation: 1, conversationKey: 'conversation:a', status: 'closed' },
      { generation: 2, conversationKey: 'conversation:b', status: 'active' },
    ]);
  });
});

describe('admin-only repair of legacy local-chatgpt identity', () => {
  const alias = 'conversation:local-chatgpt:7e49eef1-6681-4066-9c97-9a319783140e';
  const canonical = 'conversation:6b02e7a5-f5b4-83ec-8f35-667f5ce929a3';
  function fixture() {
    const plane = harness();
    const project = plane.createProject({ name: 'Pilot', rootPath: 'E:/repo', maxSlots: 3 }, 1);
    const slot = plane.createAgentSlot(project.id, 'Developer', 2);
    const org = plane.organization.createOrganization({ name: 'Pilot Organization' }, 3);
    const agent = plane.organization.registerAgent({ organizationId: org.id, displayName: 'Developer' }, 4);
    configureWorkspace(plane, agent.id, 5);
    plane.organization.bindRuntimeSlot(agent.id, slot.id, 6);
    plane.bindAgentConversation(slot.id, alias, 7);
    const mission = plane.organization.createMission({
      organizationId: org.id, projectId: project.id, title: 'Pilot mission',
      objective: 'Preserve Developer conversation continuity', driAgentId: agent.id,
    }, 8);
    plane.organization.setMissionStatus(mission.id, 'active', 9);
    const work = plane.organization.createWorkItem({
      missionId: mission.id, title: 'Greeting repair', objective: 'Return uppercase greeting',
      ownerAgentId: agent.id,
    }, 10);
    const task = { id: `org-work-${work.id}`, project: 'Pilot', targetRole: 'Developer', completionPolicy: 'verified-claim', organizationWorkItemId: work.id };
    const attempt = { attemptId: 'attempt-2', taskId: task.id, conversationKey: alias, tabId: 42, state: 'reply-observed', replyObservedAt: 11 };
    plane.database.db.prepare('INSERT INTO manager_tasks(id,position,document_json,updated_at) VALUES(?,?,?,?)')
      .run(task.id, 0, JSON.stringify(task), 11);
    plane.database.db.prepare('INSERT INTO manager_attempts(id,position,document_json,updated_at) VALUES(?,?,?,?)')
      .run(attempt.attemptId, 0, JSON.stringify(attempt), 11);
    return { plane, project, slot, agent, attempt, router: new RpcRouter(plane, 'admin-token', 'browser-token') };
  }
  const params = {
    expectedLegacyKey: alias, observedCanonicalKey: canonical, evidenceAttemptId: 'attempt-2', observedTabId: 42,
  };
  it('atomically aligns the three durable conversation projections with audited evidence', () => {
    const h = fixture();
    const response = h.router.handle({ id: 'repair', method: 'agent.repair-legacy-conversation', auth: { adminToken: 'admin-token' },
      params: { slotId: h.slot.id, ...params } });
    expect(response).toMatchObject({ ok: true, result: { conversationKey: canonical, conversationGeneration: 1 } });
    expect(h.plane.agentContinuity.active(h.agent.id)).toMatchObject({
      conversationKey: canonical, generation: 1, runtimeSlotId: h.slot.id,
    });
    expect(h.plane.conversations.listConversations(h.slot.id)).toMatchObject([
      { conversationKey: canonical, generation: 1, status: 'active' },
    ]);
    const originalAttempt = h.plane.database.db.prepare('SELECT document_json FROM manager_attempts WHERE id=?')
      .get('attempt-2') as { document_json: string };
    expect(JSON.parse(originalAttempt.document_json)).toMatchObject({ conversationKey: alias, state: 'reply-observed' });
    expect(h.plane.listEvents(h.project.id).some((e) => e.type === 'AGENT_LEGACY_CONVERSATION_ID_REPAIRED')).toBe(true);
    const duplicate = h.router.handle({ id: 'duplicate', method: 'agent.repair-legacy-conversation',
      auth: { adminToken: 'admin-token' }, params: { slotId: h.slot.id, ...params } });
    expect(duplicate.ok).toBe(false);
  });
  it('does not permit Browser tokens or missing evidence to repair a persistent identity', () => {
    const h = fixture();
    expect(h.router.handle({ id: 'browser', method: 'agent.repair-legacy-conversation',
      auth: { browserToken: 'browser-token' }, params: { slotId: h.slot.id, ...params } }).ok).toBe(false);
    expect(h.router.handle({ id: 'unknown', method: 'agent.repair-legacy-conversation',
      auth: { adminToken: 'admin-token' }, params: { slotId: h.slot.id, ...params, evidenceAttemptId: 'missing' } }).ok).toBe(false);
    expect(h.router.handle({ id: 'tab', method: 'agent.repair-legacy-conversation',
      auth: { adminToken: 'admin-token' }, params: { slotId: h.slot.id, ...params, observedTabId: 99 } }).ok).toBe(false);
    expect(h.router.handle({ id: 'bad-key', method: 'agent.repair-legacy-conversation',
      auth: { adminToken: 'admin-token' }, params: { slotId: h.slot.id, ...params, expectedLegacyKey: 'conversation:actual' } }).ok).toBe(false);
    expect(h.plane.getAgentSlot(h.slot.id).conversationKey).toBe(alias);
  });
  it('rejects already-owned canonical conversations and live browser sessions', () => {
    const h = fixture();
    const other = h.plane.createAgentSlot(h.project.id, 'Tester', 12);
    h.plane.bindAgentConversation(other.id, canonical, 13);
    const owned = h.router.handle({ id: 'owned', method: 'agent.repair-legacy-conversation',
      auth: { adminToken: 'admin-token' }, params: { slotId: h.slot.id, ...params } });
    expect(owned.ok).toBe(false);
    expect(h.plane.getAgentSlot(h.slot.id).conversationKey).toBe(alias);

    const second = fixture();
    second.plane.reportAgentBrowser({
      slotId: second.slot.id, profileId: `browser-${second.agent.id}`,
      browserState: 'open', tabId: 42, conversationKey: alias,
    }, 14);
    expect(second.router.handle({ id: 'open', method: 'agent.repair-legacy-conversation',
      auth: { adminToken: 'admin-token' }, params: { slotId: second.slot.id, ...params } }).ok).toBe(false);
  });
});
