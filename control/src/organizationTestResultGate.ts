
import type { ControlDatabase } from './database';

interface WorkRow {
  completion_policy: string;
  project_id: string | null;
  runtime_role: string | null;
}

interface StoredTask {
  kind?: unknown;
  targetRole?: unknown;
  projectId?: unknown;
  organizationWorkItemId?: unknown;
  machineCompletion?: {
    kind?: unknown;
    commitSha?: unknown;
    completedAt?: unknown;
  };
}

interface WorkspaceRow {
  id: string;
}

interface TestResult {
  projectId?: unknown;
  workItemId?: unknown;
  taskId?: unknown;
  workspaceId?: unknown;
  commitSha?: unknown;
  suite?: unknown;
  status?: unknown;
  exitCode?: unknown;
  createdAt?: unknown;
  error?: unknown;
}

function reject(reason: string): never {
  throw new Error(`Tester test result rejected: ${reason}`);
}

export function assertPassedTesterResult(
  database: ControlDatabase,
  workItemId: string,
): void {
  const db = database.db;
  const taskId = `org-work-${workItemId}`;

  const work = db.prepare(`
    SELECT
      w.completion_policy,
      m.project_id,
      s.role AS runtime_role
    FROM organization_work_items w
    JOIN missions m ON m.id = w.mission_id
    LEFT JOIN organization_agents a
      ON a.id = w.owner_agent_id
    LEFT JOIN agent_slots s
      ON s.id = a.runtime_slot_id
    WHERE w.id = ?
  `).get(workItemId) as WorkRow | undefined;

  if (!work) {
    reject('WorkItem does not exist');
  }

  const taskRow = db.prepare(`
    SELECT document_json
    FROM manager_tasks
    WHERE id = ?
  `).get(taskId) as
    | { document_json: string }
    | undefined;

  const task = taskRow
    ? JSON.parse(taskRow.document_json) as StoredTask
    : undefined;

  // Applies to execution tasks assigned to the Tester role.
  const isTester =
    work.runtime_role === 'Tester' ||
    task?.targetRole === 'Tester';

  if (!isTester) {
    return;
  }

  // A coding Tester must not bypass validation with
  // a structured-result summary.
  if (work.completion_policy !== 'verified-claim') {
    reject('Tester requires verified-claim completion');
  }

  if (
    !work.project_id ||
    !task ||
    task.kind !== 'work' ||
    task.targetRole !== 'Tester' ||
    task.projectId !== work.project_id ||
    task.organizationWorkItemId !== workItemId
  ) {
    reject('Tester execution identity mismatch');
  }

  const completion = task.machineCompletion;

  if (
    completion?.kind !== 'verified-claim' ||
    typeof completion.commitSha !== 'string' ||
    !completion.commitSha ||
    typeof completion.completedAt !== 'number'
  ) {
    reject('Verified machine completion is missing');
  }

  const workspace = db.prepare(`
    SELECT id
    FROM task_workspaces
    WHERE project_id = ? AND task_id = ?
  `).get(work.project_id, taskId) as
    WorkspaceRow | undefined;

  if (!workspace) {
    reject('Assigned Tester workspace is missing');
  }

  const event = db.prepare(`
    SELECT payload_json
    FROM events
    WHERE project_id = ?
      AND subject = ?
      AND type = 'ORG_TEST_RUN_RECORDED'
    ORDER BY seq DESC
    LIMIT 1
  `).get(work.project_id, taskId) as
    | { payload_json: string }
    | undefined;

  if (!event) {
    reject('No recorded test execution');
  }

  let result: TestResult;

  try {
    result = JSON.parse(event.payload_json) as TestResult;
  } catch {
    reject('Stored test result is invalid');
  }

  if (
    result.projectId !== work.project_id ||
    result.workItemId !== workItemId ||
    result.taskId !== taskId ||
    result.workspaceId !== workspace.id ||
    result.suite !== 'node:test'
  ) {
    reject('Test result does not belong to this execution');
  }

  if (
    result.status !== 'passed' ||
    result.exitCode !== 0 ||
    result.error
  ) {
    reject('Latest test execution did not pass');
  }

  if (result.commitSha !== completion.commitSha) {
    reject('Tested commit differs from verified commit');
  }

  if (
    typeof result.createdAt !== 'number' ||
    result.createdAt > completion.completedAt
  ) {
    reject('Test execution occurred after verification');
  }
}
