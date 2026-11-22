import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';
import { OrganizationWebPatchAuthority } from '../src/organizationWebPatchAuthority';

const gitPath = process.env.GAM_GIT_PATH || 'git';
function git(path: string, ...args: string[]): string {
  const result = spawnSync(gitPath, ['-C', path, ...args], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'git failed');
  return result.stdout.trim();
}

describe('Web Patch Authority with real Git', () => {
  it('writes scoped source, commits and records a verified outcome exactly once', () => {
    const previous = process.env.GAM_ALLOW_WEB_PATCHES;
    const dir = mkdtempSync(join(tmpdir(), 'charterion-web-patch-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    let db: ControlDatabase | undefined;
    try {
      process.env.GAM_ALLOW_WEB_PATCHES = '1';
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.name', 'Test');
      git(repo, 'config', 'user.email', 'test@example.invalid');
      writeFileSync(join(repo, 'feature.mjs'), 'export const feature = 0;\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'baseline');
      const baseline = git(repo, 'rev-parse', 'HEAD');

      db = new ControlDatabase(join(dir, 'state.db'));
      const plane = new ControlPlane(db);
      const project = plane.createProject({ name: 'WebPatchTest', rootPath: repo, maxSlots: 5 });
      const organization = plane.organization.createOrganization({ name: 'Dev Organization' });
      const agent = plane.organization.registerAgent({
        organizationId: organization.id, displayName: 'Developer',
      });
      const charter = plane.organization.activeAgentWorkspace(agent.id)!;
      const browserProfileId = `browser-${agent.id}`;
      plane.organization.configureAgentWorkspace({
        workspaceId: charter.id, rootRef: repo,
        browserProfileId, toolProfileRef: `tools-${agent.id}`,
      });
      const acquired = plane.organizationRuntime.requestAndAcquire({
        organizationId: organization.id, agentId: agent.id,
        projectId: project.id, role: 'Developer', idempotencyKey: 'web-developer',
      });
      const slotId = acquired.runtimeSlotId!;
      const tabId = 123;
      plane.reportAgentBrowser({
        slotId, profileId: browserProfileId, browserState: 'open',
        tabId, observedAt: Date.now(),
      });

      const mission = plane.organization.createMission({
        organizationId: organization.id, projectId: project.id,
        title: 'Implement feature', objective: 'Commit a real patch', driAgentId: agent.id,
      });
      plane.organization.setMissionStatus(mission.id, 'active');
      const work = plane.organization.createWorkItem({
        missionId: mission.id, title: 'Make it work', objective: 'Change feature.mjs',
        ownerAgentId: agent.id, completionPolicy: 'verified-claim',
      });
      plane.organization.setWorkStatus(work.id, 'ready');
      const projected = plane.organizationExecution.materialize(work.id);
      const workspace = plane.provisionTaskWorkspace(
        project.id, slotId, projected.managerTaskId,
      );
      const attemptId = 'web-attempt-1';
      const task = plane.work.getTask(projected.managerTaskId)!;
      db.db.prepare('UPDATE manager_tasks SET document_json=?,updated_at=? WHERE id=?').run(
        JSON.stringify({ ...task, attemptIds: [attemptId] }),
        Date.now(), projected.managerTaskId,
      );
      db.db.prepare('INSERT INTO manager_attempts(id,position,document_json,updated_at) VALUES(?,?,?,?)').run(
        attemptId, 0, JSON.stringify({
          attemptId, taskId: projected.managerTaskId, tabId,
          contentEpoch: 'epoch-1', state: 'reply-observed',
        }), Date.now(),
      );

      const authority = new OrganizationWebPatchAuthority(plane);
      const preview = authority.preview({
        projectId: project.id, taskId: projected.managerTaskId, slotId, tabId,
      });
      expect(preview.patchEnabled).toBe(true);
      expect(preview.headSha).toBe(baseline);

      const input = {
        projectId: project.id, taskId: projected.managerTaskId,
        slotId, tabId, attemptId, baseSha: baseline,
        summary: 'Implemented a concrete change to a real Git worktree',
        files: [{ path: 'feature.mjs', content: 'export const feature = 1;\n' }],
      };
      const first = authority.apply(input);
      expect(first.status).toBe('completed');
      expect(first.commitSha).not.toBe(baseline);
      expect(first.claimId).toEqual(expect.any(String));
      expect(plane.organization.getWorkItem(work.id).status).toBe('completed');
      expect(plane.workspaces.get(workspace.id).status).toBe('released');
      // A successful WorkOutcome removes the temporary worktree. The Git
      // branch is durable and remains the authoritative commit reference.
      expect(
        git(repo, 'rev-parse', `refs/heads/${workspace.branch}`),
      ).toBe(first.commitSha);
      expect(git(repo, 'rev-parse', 'refs/heads/main')).toBe(baseline);

      const replay = authority.apply(input);
      expect(replay).toEqual(first);
      expect(() => authority.apply({
        ...input, files: [{ path: 'feature.mjs', content: 'export const feature = 2;\n' }],
      })).toThrow(/replay/);
    } finally {
      db?.close();
      if (previous === undefined) delete process.env.GAM_ALLOW_WEB_PATCHES;
      else process.env.GAM_ALLOW_WEB_PATCHES = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);

  it('refuses any filesystem mutation unless the operator opted in', () => {
    const previous = process.env.GAM_ALLOW_WEB_PATCHES;
    try {
      delete process.env.GAM_ALLOW_WEB_PATCHES;
      const authority = new OrganizationWebPatchAuthority({} as ControlPlane);
      expect(() => authority.apply({
        projectId: 'no', taskId: 'org-work-no', slotId: 'no',
        tabId: 1, attemptId: 'no', baseSha: 'a'.repeat(40),
        summary: 'No writes', files: [{ path: 'source.mjs', content: 'x' }],
      })).toThrow(/disabled/);
    } finally {
      if (previous === undefined) delete process.env.GAM_ALLOW_WEB_PATCHES;
      else process.env.GAM_ALLOW_WEB_PATCHES = previous;
    }
  });
});
