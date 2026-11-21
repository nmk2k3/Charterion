
import type { ControlDatabase } from './database';

interface WorkRow {
  completion_policy: string;
  owner_agent_id: string | null;
  project_id: string | null;
  runtime_slot_id: string | null;
}

interface EvidenceRow {
  claim_status: string;
  verification_status: string;
  task_id: string;
  project_id: string;
  subject: string;
  commit_sha: string | null;
  resource_id: string;
  lease_id: string;
  lease_epoch: number;
}

interface WorkspaceRow {
  slot_id: string;
  resource_id: string;
  lease_id: string;
  lease_epoch: number;
}

function reject(reason: string): never {
  throw new Error(`Verified work result rejected: ${reason}`);
}

export function assertVerifiedWorkResult(
  database: ControlDatabase,
  workItemId: string,
): void {
  const db = database.db;

  const work = db.prepare(`
    SELECT
      w.completion_policy,
      w.owner_agent_id,
      m.project_id,
      a.runtime_slot_id
    FROM organization_work_items w
    JOIN missions m ON m.id = w.mission_id
    LEFT JOIN organization_agents a
      ON a.id = w.owner_agent_id
    WHERE w.id = ?
  `).get(workItemId) as WorkRow | undefined;

  if (!work) reject('WorkItem does not exist');

  // Structured results require a separate validation policy.
  if (work.completion_policy === 'structured-result') {
    return;
  }

  if (work.completion_policy !== 'verified-claim') {
    reject('Unsupported completion policy');
  }

  const taskId = `org-work-${workItemId}`;

  const row = db.prepare(
    'SELECT document_json FROM manager_tasks WHERE id = ?',
  ).get(taskId) as
    | { document_json: string }
    | undefined;

  if (!row) reject('Execution task is missing');

  const task = JSON.parse(row.document_json) as
    Record<string, unknown>;

  if (
    task.kind !== 'work' ||
    task.completionPolicy !== 'verified-claim' ||
    task.organizationWorkItemId !== workItemId ||
    task.organizationAgentId !== work.owner_agent_id ||
    task.projectId !== work.project_id
  ) {
    reject('Execution task identity mismatch');
  }

  const completion = task.machineCompletion as
    | {
        kind?: string;
        claimId?: string;
        verificationId?: string;
        commitSha?: string;
      }
    | undefined;

  if (
    completion?.kind !== 'verified-claim' ||
    !completion.claimId ||
    !completion.verificationId ||
    !completion.commitSha
  ) {
    reject('Verified machine completion is missing');
  }

  const evidence = db.prepare(`
    SELECT
      c.status AS claim_status,
      v.status AS verification_status,
      c.task_id,
      c.project_id,
      c.subject,
      c.commit_sha,
      c.resource_id,
      c.lease_id,
      c.lease_epoch
    FROM claims c
    JOIN verifications v ON v.claim_id = c.id
    WHERE c.id = ? AND v.id = ?
  `).get(
    completion.claimId,
    completion.verificationId,
  ) as EvidenceRow | undefined;

  if (
    !evidence ||
    evidence.claim_status !== 'verified' ||
    evidence.verification_status !== 'passed' ||
    evidence.task_id !== taskId ||
    evidence.project_id !== work.project_id ||
    evidence.subject !== work.runtime_slot_id ||
    evidence.commit_sha !== completion.commitSha
  ) {
    reject('Claim or verification does not match this task');
  }

  const workspace = db.prepare(`
    SELECT slot_id, resource_id, lease_id, lease_epoch
    FROM task_workspaces
    WHERE project_id = ? AND task_id = ?
  `).get(work.project_id, taskId) as
    WorkspaceRow | undefined;

  if (
    !workspace ||
    workspace.slot_id !== evidence.subject ||
    workspace.resource_id !== evidence.resource_id ||
    workspace.lease_id !== evidence.lease_id ||
    workspace.lease_epoch !== evidence.lease_epoch
  ) {
    reject('Verified evidence does not match the assigned workspace');
  }
}
