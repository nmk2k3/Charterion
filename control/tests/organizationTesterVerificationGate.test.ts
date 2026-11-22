import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';
import { OrganizationTestRunner } from '../src/organizationTestRunner';
import { OrganizationAutonomyScheduler } from '../src/organizationAutonomyScheduler';

const gitPath = process.env.GAM_GIT_PATH || 'git';
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(gitPath, ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000, shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'git failed');
  return result.stdout.trim();
}

describe('Tester verification before machine completion', () => {
  it('preserves failing Tester workspace for durable scheduler retry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'org-tester-failure-'));
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'test'), { recursive: true });
    let db: ControlDatabase | undefined;
    try {
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.name', 'Tester Gate');
      git(repo, 'config', 'user.email', 'test@example.invalid');
      writeFileSync(join(repo, 'value.mjs'), 'export const value = 0;\n');
      writeFileSync(join(repo, 'test', 'value.test.mjs'),
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../value.mjs';\ntest('value',()=>assert.equal(value,1));\n");
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'broken baseline');
      const base = git(repo, 'rev-parse', 'HEAD');

      db = new ControlDatabase(join(dir, 'state.db'));
      const plane = new ControlPlane(db);
      const project = plane.createProject({ name: 'Gate Project', rootPath: repo, maxSlots: 8 });
      const org = plane.organization.createOrganization({ name: 'Engineering' });
      function worker(role: 'Developer' | 'Tester') {
        const agent = plane.organization.registerAgent({ organizationId: org.id, displayName: role });
        const config = plane.organization.activeAgentWorkspace(agent.id)!;
        plane.organization.configureAgentWorkspace({
          workspaceId: config.id, rootRef: repo, browserProfileId: `browser-${agent.id}`, toolProfileRef: `tools-${agent.id}`,
        });
        const acquisition = plane.organizationRuntime.requestAndAcquire({
          organizationId: org.id, agentId: agent.id, projectId: project.id,
          role, idempotencyKey: `role-${role}`,
        });
        return { agent, slotId: acquisition.runtimeSlotId! };
      }
      const developer = worker('Developer');
      const tester = worker('Tester');
      const mission = plane.organization.createMission({
        organizationId: org.id, projectId: project.id,
        title: 'Fix regression', objective: 'Retry until passed', driAgentId: developer.agent.id,
      });
      plane.organization.setMissionStatus(mission.id, 'active');
      const work = plane.organization.createWorkItem({
        missionId: mission.id, title: 'Failing QA', objective: 'Run actual test',
        ownerAgentId: tester.agent.id, completionPolicy: 'verified-claim',
      });
      plane.organization.setWorkStatus(work.id, 'ready');
      plane.organizationExecution.materialize(work.id);
      const workspace = plane.provisionTaskWorkspace(project.id, tester.slotId, `org-work-${work.id}`);
      // A managed-worktree Git claim must point to a new, clean commit that
      // descends from the base. The test suite intentionally remains failing.
      writeFileSync(join(workspace.path, 'tester-evidence.txt'), 'Executed failing node:test suite\n');
      git(workspace.path, 'add', 'tester-evidence.txt');
      git(workspace.path, 'commit', '-m', 'test: record failing evidence');
      const testedSha = git(workspace.path, 'rev-parse', 'HEAD');
      expect(testedSha).not.toBe(base);
      const failed = new OrganizationTestRunner(plane).run(project.id, work.id);
      expect(failed.status).toBe('failed');

      const claim = plane.evidence.submitClaim({
        projectId: project.id, taskId: `org-work-${work.id}`,
        subject: tester.slotId, resourceId: workspace.resourceId, leaseEpoch: workspace.leaseEpoch,
        summary: 'Commit is valid but tests are failing', commitSha: testedSha,
      });
      const verification = plane.verifyClaimAndCompleteTask(claim.id);
      expect(verification.status).toBe('passed');
      expect(verification).toHaveProperty('machineCompletionBlocked');
      expect(plane.work.getTask(`org-work-${work.id}`)?.machineCompletion).toBeUndefined();
      expect(plane.workspaces.get(workspace.id).status).toBe('active');

      const tick = new OrganizationAutonomyScheduler(plane).tick(project.id);
      expect(tick.retryCreated).toHaveLength(1);
      expect(plane.organization.getWorkItem(work.id).status).toBe('cancelled');
      const again = new OrganizationAutonomyScheduler(plane).tick(project.id);
      expect(again.retryCreated).toHaveLength(0);
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);
});
