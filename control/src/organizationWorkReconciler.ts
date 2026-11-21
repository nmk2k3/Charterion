
import type { ControlPlane } from './controlPlane';

export interface WorkReconcileResult {
  projectId: string;
  projectedTaskIds: string[];
  blocked: Array<{
    workItemId: string;
    reason: string;
  }>;
}

export class OrganizationWorkReconciler {
  constructor(private readonly plane: ControlPlane) {}

  reconcile(projectId: string): WorkReconcileResult {
    const project = this.plane.listProjects()
      .find((item) => item.id === projectId);

    if (!project || project.status !== 'active') {
      throw new Error('Reconciliation requires an active project');
    }

    const result: WorkReconcileResult = {
      projectId,
      projectedTaskIds: [],
      blocked: [],
    };

    const acquisitions = this.plane.organizationRuntime
      .list(undefined, projectId);

    const works = this.plane.organization.listWorkItems()
      .filter((work) =>
        this.plane.organization.getMission(work.missionId)
          .projectId === projectId
      )
      .sort((a, b) =>
        a.createdAt - b.createdAt || a.id.localeCompare(b.id)
      );

    for (const work of works) {
      if (!['proposed', 'ready'].includes(work.status)) {
        continue;
      }

      const taskId = `org-work-${work.id}`;

      // Never create a duplicate execution task.
      if (this.plane.work.getTask(taskId)) {
        continue;
      }

      const mission = this.plane.organization
        .getMission(work.missionId);

      if (mission.status !== 'active') {
        result.blocked.push({
          workItemId: work.id,
          reason: `Mission is ${mission.status}`,
        });
        continue;
      }

      const pending = work.dependsOn.filter(
        (dependencyId) =>
          this.plane.organization.getWorkItem(dependencyId)
            .status !== 'completed',
      );

      if (pending.length > 0) {
        result.blocked.push({
          workItemId: work.id,
          reason: `Pending dependencies: ${pending.join(', ')}`,
        });
        continue;
      }

      if (!work.ownerAgentId) {
        result.blocked.push({
          workItemId: work.id,
          reason: 'No assigned owner',
        });
        continue;
      }

      try {
        const agent = this.plane.organization
          .getAgent(work.ownerAgentId);

        const workspace = this.plane.organization
          .activeAgentWorkspace(agent.id);

        const acquisition = acquisitions.find(
          (item) =>
            item.agentId === agent.id &&
            item.status === 'acquired' &&
            item.runtimeSlotId === agent.runtimeSlotId,
        );

        if (
          agent.status !== 'active' ||
          workspace?.status !== 'ready' ||
          !agent.runtimeSlotId ||
          !acquisition
        ) {
          result.blocked.push({
            workItemId: work.id,
            reason: 'Agent runtime or workspace is not ready',
          });
          continue;
        }

        if (work.status === 'proposed') {
          this.plane.organization.setWorkStatus(
            work.id,
            'ready',
          );
        }

        const projection = this.plane
          .organizationExecution.materialize(work.id);

        result.projectedTaskIds.push(
          projection.managerTaskId,
        );
      } catch (error) {
        result.blocked.push({
          workItemId: work.id,
          reason:
            error instanceof Error
              ? error.message
              : String(error),
        });
      }
    }

    return result;
  }
}
