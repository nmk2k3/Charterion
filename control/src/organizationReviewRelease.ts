import type { ControlPlane } from './controlPlane';
import type { OrganizationWorkflowReconciliation } from './organizationWorkflowCoordinator';

/**
 * Releases code review only after the final Tester WorkOutcome has been
 * committed. Can be safely called after a crash or an RPC replay.
 */
export class OrganizationReviewRelease {
  constructor(private readonly plane: ControlPlane) {}

  reconcile(workItemId: string, now = Date.now()):
    OrganizationWorkflowReconciliation | { status: 'not-applicable'; workItemId: string; organizationId: string } {
    const work = this.plane.organization.getWorkItem(workItemId);
    const mission = this.plane.organization.getMission(work.missionId);
    if (!mission.projectId || !work.ownerAgentId) {
      return { status: 'not-applicable', workItemId, organizationId: mission.organizationId };
    }
    const agent = this.plane.organization.getAgent(work.ownerAgentId);
    const role = agent.runtimeSlotId
      ? this.plane.getAgentSlot(agent.runtimeSlotId).role : '';
    if (role !== 'Tester' || work.completionPolicy !== 'verified-claim') {
      return { status: 'not-applicable', workItemId, organizationId: mission.organizationId };
    }
    if (work.status !== 'completed') {
      return { status: 'blocked', workItemId, organizationId: mission.organizationId,
        reason: 'Tester WorkItem is not completed' };
    }

    const taskId = `org-work-${work.id}`;
    const task = this.plane.work.getTask(taskId);
    const completion = task?.machineCompletion as {
      kind?: string; claimId?: string; verificationId?: string; commitSha?: string;
    } | undefined;
    if (completion?.kind !== 'verified-claim' || !completion.claimId || !completion.verificationId || !completion.commitSha) {
      return { status: 'blocked', workItemId, organizationId: mission.organizationId,
        reason: 'Tester machine completion evidence is missing' };
    }

    const claim = this.plane.evidence.getClaim(completion.claimId);
    const verification = this.plane.evidence.getVerification(completion.verificationId);
    const workspace = this.plane.workspaces.find(mission.projectId, taskId);
    if (claim.taskId !== taskId || claim.projectId !== mission.projectId ||
        claim.commitSha !== completion.commitSha || verification.claimId !== claim.id) {
      return { status: 'blocked', workItemId, organizationId: mission.organizationId,
        reason: 'Tester completion evidence identity mismatch' };
    }
    return this.plane.organizationWorkflow.reconcileVerifiedWork(claim, verification, workspace, now);
  }
}
