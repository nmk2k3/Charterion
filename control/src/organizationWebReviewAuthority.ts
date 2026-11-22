import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { ControlPlane } from './controlPlane';
import { assertOrganizationReviewReady } from './organizationReviewGate';

const MAX_DIFF_CHARS = 9_000;
const MAX_NOTE_CHARS = 1_000;

export type WebReviewDecision = 'approve' | 'request-changes' | 'reject';
export interface WebReviewPreview {
  taskId: string;
  slotId: string;
  reviewSlotId: string;
  reviewRequestId: string;
  headSha: string;
  diff: string;
  diffComplete: boolean;
  reviewEnabled: boolean;
  promotionEnabled: boolean;
}
export interface WebReviewDecisionInput {
  projectId: string;
  taskId: string;
  slotId: string;
  tabId: number;
  attemptId: string;
  reviewSlotId: string;
  headSha: string;
  decision: WebReviewDecision;
  note: string;
}
export interface WebReviewDecisionResult {
  projectId: string;
  taskId: string;
  attemptId: string;
  reviewSlotId: string;
  decision: WebReviewDecision;
  status: 'decided' | 'approved-awaiting-promotion' | 'promoted' | 'promotion-blocked';
  headSha: string;
  requestHash: string;
  reason?: string;
}

interface AttemptDocument {
  attemptId?: string;
  taskId?: string;
  tabId?: number;
  contentEpoch?: string;
  state?: string;
}

export class OrganizationWebReviewAuthority {
  constructor(private readonly plane: ControlPlane) {}

  private context(input: {
    projectId: string; taskId: string; slotId: string; tabId: number;
  }, allowSettled = false) {
    const { projectId, taskId, slotId, tabId } = input;
    const slot = this.plane.getAgentSlot(slotId);
    const task = this.plane.work.getTask(taskId);
    if (!task || !taskId.startsWith('org-work-') ||
        typeof task.organizationWorkItemId !== 'string' ||
        task.organizationWorkItemId !== taskId.slice('org-work-'.length) ||
        task.projectId !== projectId || slot.projectId !== projectId ||
        task.targetRole !== slot.role || !slot.role.startsWith('Review:') ||
        slot.desiredState !== 'active' || slot.browserQuarantined ||
        slot.browserState !== 'open' || slot.browserTabId !== tabId) {
      throw new Error('Web review is not bound to the assigned reviewer browser tab');
    }
    const work = this.plane.organization.getWorkItem(task.organizationWorkItemId);
    const mission = this.plane.organization.getMission(work.missionId);
    const agent = work.ownerAgentId
      ? this.plane.organization.getAgent(work.ownerAgentId) : undefined;
    if (mission.projectId !== projectId || work.completionPolicy !== 'structured-result' ||
        !['ready', 'active'].includes(work.status) ||
        !agent || agent.runtimeSlotId !== slotId || agent.status !== 'active') {
      throw new Error('Web review Organization WorkItem or reviewer identity is stale');
    }
    const binding = this.plane.database.db.prepare(`
      SELECT review_slot_id,review_request_id,reviewer_agent_id
      FROM organization_review_work_items WHERE work_item_id=?
    `).get(work.id) as
      { review_slot_id: string; review_request_id: string; reviewer_agent_id: string } | undefined;
    if (!binding || binding.reviewer_agent_id !== agent.id) {
      throw new Error('Web review has no durable Review Pool binding');
    }
    const request = this.plane.reviewPool.getRequest(binding.review_request_id);
    if ((!allowSettled && request.status !== 'open') ||
        (allowSettled && !['open','approved','changes-requested','rejected'].includes(request.status)) ||
        request.projectId !== projectId ||
        request.organizationId !== mission.organizationId) {
      throw new Error('Web Review Pool request is not open in this Mission');
    }
    const change = this.plane.changes.getChangeRequest(request.changeRequestId);
    if (change.projectId !== projectId || change.headSha !== request.headSha) {
      throw new Error('Web review Change Request evidence is stale');
    }
    const reviewSlot = this.plane.reviewPool.getSlot(binding.review_slot_id);
    if (reviewSlot.reviewRequestId !== request.id ||
        !(['open', 'claimed'].includes(reviewSlot.state) ||
          (allowSettled && ['approved','changes-requested','rejected'].includes(reviewSlot.state))) ||
        (reviewSlot.state !== 'open' && reviewSlot.reviewerAgentId !== agent.id)) {
      throw new Error('Web review slot is no longer eligible');
    }
    assertOrganizationReviewReady(this.plane.database, change.taskId, change.claimId, change.headSha);
    return { slot, task, work, agent, binding, request, change, reviewSlot };
  }

  preview(input: {
    projectId: string; taskId: string; slotId: string; tabId: number;
  }): WebReviewPreview {
    const { change, request, binding } = this.context(input);
    const project = this.plane.listProjects().find((item) => item.id === input.projectId);
    if (!project) throw new Error('Review project is missing');
    const command = spawnSync(process.env.GAM_GIT_PATH || 'git', [
      '-C', project.rootPath, 'diff', '--no-ext-diff', '--unified=3',
      change.baseSha, change.headSha, '--',
    ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 15_000, maxBuffer: 250_000 });
    if (command.status !== 0) {
      throw new Error(command.stderr || command.error?.message || 'Unable to inspect reviewed Git diff');
    }
    const full = command.stdout;
    return {
      taskId: input.taskId, slotId: input.slotId,
      reviewSlotId: binding.review_slot_id, reviewRequestId: request.id,
      headSha: change.headSha,
      diff: full.slice(0, MAX_DIFF_CHARS),
      diffComplete: full.length <= MAX_DIFF_CHARS,
      reviewEnabled: process.env.GAM_ALLOW_WEB_REVIEWS === '1',
      promotionEnabled: process.env.GAM_ALLOW_WEB_PROMOTIONS === '1',
    };
  }

  decide(input: WebReviewDecisionInput, now = Date.now()): WebReviewDecisionResult {
    if (process.env.GAM_ALLOW_WEB_REVIEWS !== '1') {
      throw new Error('AI Web review decisions require GAM_ALLOW_WEB_REVIEWS=1');
    }
    if (!['approve', 'request-changes', 'reject'].includes(input.decision) ||
        typeof input.note !== 'string' || input.note.trim().length < 12 ||
        input.note.length > MAX_NOTE_CHARS) {
      throw new Error('Web review decision or evidence note is invalid');
    }
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const last = this.plane.database.db.prepare(`
      SELECT type,payload_json FROM events
      WHERE project_id=? AND subject=? AND type IN ('ORG_WEB_REVIEW_STARTED','ORG_WEB_REVIEW_DECIDED')
      ORDER BY seq DESC LIMIT 1
    `).get(input.projectId, input.attemptId) as
      { type: string; payload_json: string } | undefined;
    if (last?.type === 'ORG_WEB_REVIEW_DECIDED') {
      const result = JSON.parse(last.payload_json) as WebReviewDecisionResult;
      if (result.requestHash !== requestHash || result.taskId !== input.taskId) {
        throw new Error('Web review replay differs from the durable decision');
      }
      return result;
    }

    const { task, agent, reviewSlot, request, change } = this.context(input, last?.type === 'ORG_WEB_REVIEW_STARTED');
    if (reviewSlot.id !== input.reviewSlotId || change.headSha !== input.headSha) {
      throw new Error('Web review response is for a different review slot or commit');
    }
    const row = this.plane.database.db.prepare(
      'SELECT document_json FROM manager_attempts WHERE id=?',
    ).get(input.attemptId) as { document_json: string } | undefined;
    const attempt = row ? JSON.parse(row.document_json) as AttemptDocument : undefined;
    if (!attempt || attempt.attemptId !== input.attemptId ||
        attempt.taskId !== input.taskId || attempt.tabId !== input.tabId ||
        attempt.state !== 'reply-observed' || !attempt.contentEpoch ||
        (this.plane.getAgentSlot(input.slotId).browserContentEpoch &&
          attempt.contentEpoch !== this.plane.getAgentSlot(input.slotId).browserContentEpoch) ||
        !task.attemptIds || !(task.attemptIds as string[]).includes(input.attemptId)) {
      throw new Error('Web review response lacks a matching durable reply-observed attempt');
    }
    if (input.decision === 'approve' && !this.preview({
      projectId: input.projectId, taskId: input.taskId,
      slotId: input.slotId, tabId: input.tabId,
    }).diffComplete) {
      throw new Error('AI approval refuses truncated Git diffs');
    }

    if (last?.type === 'ORG_WEB_REVIEW_STARTED') {
      const started = JSON.parse(last.payload_json) as { requestHash: string };
      if (started.requestHash !== requestHash) throw new Error('Interrupted Web review replay changed payload');
      const currentSlot = this.plane.reviewPool.getSlot(reviewSlot.id);
      const expectedState = input.decision === 'approve' ? 'approved' :
        input.decision === 'reject' ? 'rejected' : 'changes-requested';
      if (currentSlot.state !== expectedState ||
          currentSlot.reviewerAgentId !== agent.id ||
          currentSlot.decisionNote !== input.note.trim()) {
        throw new Error('Interrupted review cannot be safely replayed; manual reconciliation required');
      }
    } else {
      this.plane.database.db.prepare(
        'INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(?,?,?,?,?)',
      ).run(input.projectId, 'ORG_WEB_REVIEW_STARTED', input.attemptId,
        JSON.stringify({ taskId: input.taskId, requestHash, reviewSlotId: reviewSlot.id }), now);
      if (reviewSlot.state === 'open') {
        this.plane.reviewPool.claim({ slotId: reviewSlot.id, reviewerAgentId: agent.id }, now);
      }
      this.plane.reviewPool.decide({
        slotId: reviewSlot.id, reviewerAgentId: agent.id,
        decision: input.decision, note: input.note.trim(),
      }, now);
    }

    const latestRequest = this.plane.reviewPool.getRequest(request.id);
    const result: WebReviewDecisionResult = {
      projectId: input.projectId, taskId: input.taskId,
      attemptId: input.attemptId, reviewSlotId: reviewSlot.id,
      decision: input.decision, headSha: change.headSha, requestHash,
      status: latestRequest.status === 'approved'
        ? 'approved-awaiting-promotion' : 'decided',
    };
    // Store the decision first. Promotion is a separate replayable effect.
    this.plane.database.db.prepare(
      'INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(?,?,?,?,?)',
    ).run(input.projectId, 'ORG_WEB_REVIEW_DECIDED', input.attemptId, JSON.stringify(result), now);

    if (latestRequest.status === 'approved' && process.env.GAM_ALLOW_WEB_PROMOTIONS === '1') {
      // Reconciliation is retried by the durable scheduler if it fails.
      try {
        this.plane.organizationWorkflow.reconcileReviewDecision(request.id, now);
        result.status = 'promoted';
      } catch (error) {
        result.status = 'promotion-blocked';
        result.reason = error instanceof Error ? error.message : String(error);
      }
    }
    return result;
  }
}
