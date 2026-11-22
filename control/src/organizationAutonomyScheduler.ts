import type { ControlPlane } from './controlPlane';
import { OrganizationRetryController } from './organizationRetryController';
import { OrganizationTestRunner } from './organizationTestRunner';
import { OrganizationWorkReconciler } from './organizationWorkReconciler';
import { OrganizationReviewRelease } from './organizationReviewRelease';

export interface OrganizationAutonomyTick {
  projectId: string;
  retryCreated: string[];
  exhausted: string[];
  reviewReleased: string[];
  projectedTaskIds: string[];
  blocked: Array<{ workItemId: string; reason: string }>;
}

export class OrganizationAutonomyScheduler {
  constructor(private readonly plane: ControlPlane) {}

  private role(agentId: string | undefined): string {
    if (!agentId) return '';
    const agent = this.plane.organization.getAgent(agentId);
    return agent.runtimeSlotId ? this.plane.getAgentSlot(agent.runtimeSlotId).role : '';
  }

  private reviewAlreadyMaterialized(projectId: string, workItemId: string): boolean {
    const taskId = `org-work-${workItemId}`;
    const row = this.plane.database.db.prepare(`
      SELECT rr.id
      FROM change_requests cr
      JOIN review_requests rr ON rr.change_request_id=cr.id AND rr.revision=cr.revision
      WHERE cr.project_id=? AND cr.task_id=? AND rr.status IN ('open','approved')
      ORDER BY rr.updated_at DESC LIMIT 1
    `).get(projectId, taskId) as { id?: string } | undefined;
    if (!row?.id) return false;
    const required = this.plane.database.db.prepare(
      'SELECT COUNT(*) AS count FROM review_slots WHERE review_request_id=? AND required=1',
    ).get(row.id) as { count: number };
    const materialized = this.plane.database.db.prepare(
      'SELECT COUNT(*) AS count FROM organization_review_work_items WHERE review_request_id=?',
    ).get(row.id) as { count: number };
    return required.count > 0 && materialized.count >= required.count;
  }

  /**
   * Converges database truth only. Browser prompting and Git execution remain
   * in their existing extension/Workspace boundary; this method never treats
   * an AI reply as verified task completion.
   */
  tick(projectId: string, now = Date.now()): OrganizationAutonomyTick {
    const project = this.plane.listProjects().find((item) => item.id === projectId);
    if (!project || project.status !== 'active') {
      throw new Error('Autonomy tick requires an active project');
    }
    const result: OrganizationAutonomyTick = {
      projectId, retryCreated: [], exhausted: [], reviewReleased: [],
      projectedTaskIds: [], blocked: [],
    };
    const missions = this.plane.organization.listMissions()
      .filter((mission) => mission.projectId === projectId && mission.status === 'active');
    for (const mission of missions) {
      const works = this.plane.organization.listWorkItems(mission.id);
      const developer = [...works].reverse().find((item) =>
        this.role(item.ownerAgentId) === 'Developer' && item.ownerAgentId &&
        this.plane.organization.getAgent(item.ownerAgentId).status === 'active'
      )?.ownerAgentId;
      for (const work of works) {
        if (this.role(work.ownerAgentId) !== 'Tester') continue;
        if (work.status === 'completed') {
          if (this.reviewAlreadyMaterialized(projectId, work.id)) continue;
          try {
            const review = new OrganizationReviewRelease(this.plane).reconcile(work.id, now);
            if (review.status === 'review-ready') result.reviewReleased.push(work.id);
            else if (review.status === 'blocked') result.blocked.push({
              workItemId: work.id, reason: review.reason ?? 'Review release blocked',
            });
          } catch (error) {
            result.blocked.push({
              workItemId: work.id, reason: error instanceof Error ? error.message : String(error),
            });
          }
          continue;
        }
        if (!['ready', 'active'].includes(work.status)) continue;
        const latest = new OrganizationTestRunner(this.plane).latest(projectId, work.id);
        if (latest?.status !== 'failed') continue;
        if (!developer) {
          result.blocked.push({ workItemId: work.id, reason: 'No active Developer in Mission' });
          continue;
        }
        try {
          const retry = new OrganizationRetryController(this.plane).request({
            projectId, failedTesterWorkItemId: work.id, developerAgentId: developer,
          }, now);
          if (retry.action === 'created' && !retry.reused) {
            result.retryCreated.push(retry.round.id);
          } else if (retry.action === 'exhausted') {
            this.plane.organization.setMissionStatus(mission.id, 'blocked', now);
            this.plane.database.db.prepare(
              'INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(?,?,?,?,?)',
            ).run(projectId, 'ORG_AUTONOMY_RETRIES_EXHAUSTED', mission.id,
              JSON.stringify({ workItemId: work.id, attemptsUsed: retry.attemptsUsed }), now);
            result.exhausted.push(mission.id);
          }
        } catch (error) {
          result.blocked.push({
            workItemId: work.id, reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const projection = new OrganizationWorkReconciler(this.plane).reconcile(projectId);
    result.projectedTaskIds.push(...projection.projectedTaskIds);
    result.blocked.push(...projection.blocked);
    return result;
  }
}
