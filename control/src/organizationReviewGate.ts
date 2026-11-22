
import type { ControlDatabase } from './database';
import { assertPassedTesterResult } from './organizationTestResultGate';

interface WorkRow {
  id: string;
  mission_id: string;
  status: string;
  completion_policy: string;
  project_id: string | null;
  role: string | null;
}

interface TesterRow {
  id: string;
  status: string;
}

interface MachineCompletion {
  kind?: string;
  claimId?: string;
  verificationId?: string;
  commitSha?: string;
}

interface TaskDocument {
  id?: string;
  targetRole?: string;
  projectId?: string;
  organizationWorkItemId?: string;
  machineCompletion?: MachineCompletion;
}

function deny(reason: string): never {
  throw new Error(`Reviewer Gate: ${reason}`);
}

export function assertOrganizationReviewReady(
  database: ControlDatabase,
  taskId: string,
  claimId: string,
  headSha: string,
): void {
  // Preserve legacy, non-Organization review workflows.
  if (!taskId.startsWith('org-work-')) {
    return;
  }

  const db = database.db;
  const workItemId = taskId.slice('org-work-'.length);

  const source = db.prepare(`
    SELECT
      w.id,
      w.mission_id,
      w.status,
      w.completion_policy,
      m.project_id,
      s.role
    FROM organization_work_items w
    JOIN missions m ON m.id = w.mission_id
    LEFT JOIN organization_agents a
      ON a.id = w.owner_agent_id
    LEFT JOIN agent_slots s
      ON s.id = a.runtime_slot_id
    WHERE w.id = ?
  `).get(workItemId) as WorkRow | undefined;

  if (!source || !source.project_id) {
    deny('Organization Work source is missing');
  }

  // A Reviewer must not initiate another review
  // from its own completion claim.
  if (
    source.role === 'Reviewer' ||
    source.role?.startsWith('Review:')
  ) {
    deny('Review work cannot create another review');
  }

  const testers = db.prepare(`
    SELECT w.id, w.status
    FROM organization_work_items w
    JOIN organization_agents a
      ON a.id = w.owner_agent_id
    JOIN agent_slots s
      ON s.id = a.runtime_slot_id
    WHERE w.mission_id = ?
      AND s.role = 'Tester'
    ORDER BY w.created_at, w.id
  `).all(source.mission_id) as unknown as TesterRow[];

  // Legacy missions without an acquired runtime retain
  // the previous workflow for compatibility.
  //
  // A real Developer runtime, however, cannot skip Tester.
  if (testers.length === 0) {
    if (source.role === 'Developer') {
      deny('Developer Mission requires a Tester');
    }

    return;
  }

  // Only a completed Tester may provide the source
  // commit of the final code review.
  if (source.role !== 'Tester') {
    deny('Review must originate from verified Tester work');
  }

  if (
    source.status !== 'completed' ||
    source.completion_policy !== 'verified-claim'
  ) {
    deny('Tester WorkItem has not completed');
  }

  // Every relevant Tester must have completed.
  // Cancelled Testers are acceptable only when
  // replaced by a durable retry round.
  for (const tester of testers) {
    if (tester.status === 'cancelled') {
      const retry = db.prepare(`
        SELECT id
        FROM organization_retry_rounds
        WHERE failed_tester_work_item_id = ?
      `).get(tester.id) as { id: string } | undefined;

      if (!retry) {
        deny(
          `Cancelled Tester ${tester.id} has no retry replacement`,
        );
      }

      continue;
    }

    if (tester.status !== 'completed') {
      deny(`Tester ${tester.id} has not completed`);
    }

    const outcome = db.prepare(`
      SELECT disposition
      FROM work_outcomes
      WHERE work_item_id = ?
    `).get(tester.id) as
      | { disposition: string }
      | undefined;

    if (outcome?.disposition !== 'completed') {
      deny(`Tester ${tester.id} has no completed outcome`);
    }

    // Revalidate actual stored test evidence, even
    // if an old WorkItem says completed.
    try {
      assertPassedTesterResult(database, tester.id);
    } catch (error) {
      deny(
        error instanceof Error
          ? error.message
          : String(error),
      );
    }
  }

  const row = db.prepare(`
    SELECT document_json
    FROM manager_tasks
    WHERE id = ?
  `).get(taskId) as
    | { document_json: string }
    | undefined;

  if (!row) {
    deny('Verified Tester task is missing');
  }

  let task: TaskDocument;

  try {
    task = JSON.parse(row.document_json) as TaskDocument;
  } catch {
    deny('Verified Tester task document is invalid');
  }

  if (
    task.targetRole !== 'Tester' ||
    task.projectId !== source.project_id ||
    task.organizationWorkItemId !== source.id
  ) {
    deny('Tester task identity mismatch');
  }

  const completion = task.machineCompletion;

  if (
    completion?.kind !== 'verified-claim' ||
    !completion.claimId ||
    !completion.verificationId ||
    !completion.commitSha
  ) {
    deny('Verified Tester completion is missing');
  }

  if (
    completion.claimId !== claimId ||
    completion.commitSha.toLowerCase() !==
      headSha.toLowerCase()
  ) {
    deny('Review head differs from verified Tester commit');
  }

  const claim = db.prepare(`
    SELECT
      id, project_id, task_id,
      commit_sha, status
    FROM claims
    WHERE id = ?
  `).get(claimId) as
    | {
        id: string;
        project_id: string;
        task_id: string;
        commit_sha: string | null;
        status: string;
      }
    | undefined;

  if (
    claim?.status !== 'verified' ||
    claim.project_id !== source.project_id ||
    claim.task_id !== taskId ||
    claim.commit_sha?.toLowerCase() !==
      headSha.toLowerCase()
  ) {
    deny('Review claim is not verified for this Tester');
  }

  const verification = db.prepare(`
    SELECT claim_id, status
    FROM verifications
    WHERE id = ?
  `).get(completion.verificationId) as
    | { claim_id: string; status: string }
    | undefined;

  if (
    verification?.claim_id !== claimId ||
    verification.status !== 'passed'
  ) {
    deny('Tester claim verification is not passed');
  }
}
