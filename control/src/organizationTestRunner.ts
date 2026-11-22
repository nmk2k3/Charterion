
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ControlPlane } from './controlPlane';

export type OrganizationTestStatus =
  | 'passed'
  | 'failed'
  | 'timeout'
  | 'invalid';

export interface OrganizationTestResult {
  id: string;
  projectId: string;
  workItemId: string;
  taskId: string;
  workspaceId: string;
  commitSha: string;
  suite: 'node:test';
  status: OrganizationTestStatus;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
  createdAt: number;
}

export type TestRunResponse = OrganizationTestResult & {
  reused: boolean;
};

const TEST_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const STORED_OUTPUT_CHARS = 4_000;

export class OrganizationTestRunner {
  constructor(private readonly plane: ControlPlane) {}

  private context(projectId: string, workItemId: string) {
    const project = this.plane.listProjects()
      .find((item) => item.id === projectId);

    if (!project || project.status !== 'active') {
      throw new Error('Test Runner requires an active project');
    }

    const work = this.plane.organization.getWorkItem(workItemId);
    const mission = this.plane.organization.getMission(
      work.missionId,
    );

    if (
      mission.projectId !== projectId ||
      mission.status !== 'active'
    ) {
      throw new Error('WorkItem is not in an active project mission');
    }

    if (!['ready', 'active'].includes(work.status)) {
      throw new Error('WorkItem is not executable');
    }

    if (!work.ownerAgentId) {
      throw new Error('WorkItem has no owner');
    }

    const agent = this.plane.organization.getAgent(
      work.ownerAgentId,
    );

    const taskId = `org-work-${workItemId}`;
    const task = this.plane.work.getTask(taskId);

    if (
      !task ||
      task.kind !== 'work' ||
      task.targetRole !== 'Tester' ||
      task.projectId !== projectId ||
      task.organizationWorkItemId !== workItemId ||
      task.organizationAgentId !== agent.id
    ) {
      throw new Error('Test Runner requires a valid Tester task');
    }

    const workspace = this.plane.workspaces.find(
      projectId,
      taskId,
    );

    if (
      !workspace ||
      workspace.status !== 'active' ||
      !agent.runtimeSlotId ||
      workspace.slotId !== agent.runtimeSlotId
    ) {
      throw new Error('Tester has no active assigned workspace');
    }

    return { taskId, workspace };
  }

  latest(
    projectId: string,
    workItemId: string,
  ): OrganizationTestResult | undefined {
    const taskId = `org-work-${workItemId}`;

    const row = this.plane.database.db.prepare(`
      SELECT payload_json
      FROM events
      WHERE project_id = ?
        AND subject = ?
        AND type = 'ORG_TEST_RUN_RECORDED'
      ORDER BY seq DESC
      LIMIT 1
    `).get(projectId, taskId) as
      | { payload_json: string }
      | undefined;

    return row
      ? JSON.parse(row.payload_json) as OrganizationTestResult
      : undefined;
  }

  run(
    projectId: string,
    workItemId: string,
    force = false,
  ): TestRunResponse {
    const { taskId, workspace } =
      this.context(projectId, workItemId);

    const before = this.plane.workspaces.observe(
      workspace.id,
    );

    if (before.dirty) {
      throw new Error(
        'Tester workspace must be clean before running tests',
      );
    }

    const previous = this.latest(projectId, workItemId);

    // Do not rerun the same commit unintentionally.
    if (
      !force &&
      previous?.workspaceId === workspace.id &&
      previous.commitSha === before.headSha &&
      ['passed', 'failed'].includes(previous.status)
    ) {
      return { ...previous, reused: true };
    }

    const startedAt = Date.now();

    // Deliberately restricted to Node's built-in test runner.
    // No user-provided shell command is accepted.
    const execution = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap'],
      {
        cwd: workspace.path,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: TEST_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: {
          PATH: process.env.PATH,
          Path: process.env.Path,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          NODE_ENV: 'test',
          CI: 'true',
          NO_COLOR: '1',
        },
      },
    );

    const durationMs = Date.now() - startedAt;

    let invalidReason: string | undefined;

    try {
      const after = this.plane.workspaces.observe(
        workspace.id,
      );

      if (
        after.headSha !== before.headSha ||
        after.dirty
      ) {
        invalidReason =
          'Workspace HEAD or working tree changed during test execution';
      }
    } catch (error) {
      invalidReason =
        error instanceof Error
          ? error.message
          : String(error);
    }

    const processError = execution.error as
      | NodeJS.ErrnoException
      | undefined;

    const tapOutput = String(execution.stdout ?? '');

    const testCountMatch = /^# tests (\d+)\s*$/m.exec(
    tapOutput,
    );

    const testCount = Number(
    testCountMatch?.[1] ?? 0,
    );

    if (
    !invalidReason &&
    execution.status === 0 &&
    testCount === 0
    ) {
    invalidReason = 'No tests were discovered or executed';
    }

    let status: OrganizationTestStatus;

    if (invalidReason) {
      status = 'invalid';
    } else if (processError?.code === 'ETIMEDOUT') {
      status = 'timeout';
    } else if (
      execution.status === 0 &&
      !processError
    ) {
      status = 'passed';
    } else {
      status = 'failed';
    }

    const result: OrganizationTestResult = {
      id: randomUUID(),
      projectId,
      workItemId,
      taskId,
      workspaceId: workspace.id,
      commitSha: before.headSha,
      suite: 'node:test',
      status,
      exitCode: execution.status,
      durationMs,
      stdout: String(execution.stdout ?? '')
        .slice(-STORED_OUTPUT_CHARS),
      stderr: String(execution.stderr ?? '')
        .slice(-STORED_OUTPUT_CHARS),
      createdAt: Date.now(),
    };

    const error = invalidReason ?? processError?.message;

    if (error) {
      result.error = error.slice(0, 1000);
    }

    // Persist the result in Kernel's append-only event log.
    this.plane.database.db.prepare(`
      INSERT INTO events(
        project_id,
        type,
        subject,
        payload_json,
        created_at
      )
      VALUES(?, 'ORG_TEST_RUN_RECORDED', ?, ?, ?)
    `).run(
      projectId,
      taskId,
      JSON.stringify(result),
      result.createdAt,
    );

    return { ...result, reused: false };
  }
}
