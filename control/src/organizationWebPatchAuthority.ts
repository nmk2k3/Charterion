import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ControlPlane } from './controlPlane';
import { OrganizationTestRunner } from './organizationTestRunner';
import { OrganizationReviewRelease } from './organizationReviewRelease';
import { OrganizationWorkReconciler } from './organizationWorkReconciler';

const MAX_FILES = 8;
const MAX_PATCH_CHARS = 10_000;
const MAX_CONTEXT_CHARS = 9_000;
const SAFE_FILE = /^[a-zA-Z0-9_.@+()/-]{1,220}$/;
const DISALLOWED = new Set(['.git', 'node_modules', '.env', '.ssh', '.npmrc',
  'dist', 'dist-control', 'dist-native-host', 'capabilities', '.gitignore.lock']);

export interface WebPatchFile {
  path: string;
  content: string;
}

export interface WebPatchRequest {
  projectId: string;
  taskId: string;
  slotId: string;
  tabId: number;
  attemptId: string;
  baseSha: string;
  summary: string;
  files: WebPatchFile[];
}

export interface WebPatchResult {
  projectId: string;
  taskId: string;
  attemptId: string;
  status: 'completed' | 'test-failed';
  commitSha: string;
  claimId?: string;
  testResultId?: string;
}

function requireText(value: string, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Web patch ${name} is missing or too long`);
  }
  return value.trim();
}

function safeRelativePath(path: string): string {
  const name = requireText(path, 'path', 220);
  if (!SAFE_FILE.test(name) || name.startsWith('/') || name.includes('\\') ||
      name.includes('//') || isAbsolute(name)) {
    throw new Error('Web patch path is not a safe relative filename');
  }
  const parts = name.split('/');
  if (parts.some((part) => part === '.' || part === '..' || !part ||
      DISALLOWED.has(part.toLowerCase()) || part.toLowerCase().startsWith('.env.'))) {
    throw new Error('Web patch path contains a protected segment');
  }
  return parts.join('/');
}

function fileInside(worktree: string, relativePath: string): string {
  const root = resolve(worktree);
  const target = resolve(root, ...relativePath.split('/'));
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Web patch path escapes assigned worktree');
  }
  let segment = root;
  for (const part of relativePath.split('/')) {
    segment = join(segment, part);
    if (existsSync(segment) && lstatSync(segment).isSymbolicLink()) {
      throw new Error('Web patch refuses symbolic-link targets');
    }
  }
  return target;
}

function git(cwd: string, args: string[], gitPath = 'git'): string {
  const child = spawnSync(gitPath, ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 25_000, shell: false,
  });
  if (child.status !== 0) throw new Error((child.stderr || child.error?.message || 'Git failed').trim());
  return child.stdout.trim();
}

type AttemptDocument = {
  attemptId?: string;
  taskId?: string;
  tabId?: number;
  state?: string;
  conversationKey?: string;
};

export class OrganizationWebPatchAuthority {
  constructor(private readonly plane: ControlPlane) {}

  private context(projectId: string, taskId: string, slotId: string, tabId: number) {
    const slot = this.plane.getAgentSlot(slotId);
    const task = this.plane.work.getTask(taskId);
    const workspace = this.plane.workspaces.find(projectId, taskId);
    if (!taskId.startsWith('org-work-') || !task ||
        typeof task.organizationWorkItemId !== 'string' ||
        taskId !== `org-work-${task.organizationWorkItemId}` ||
        task.projectId !== projectId || task.targetRole !== slot.role ||
        slot.projectId !== projectId || slot.desiredState !== 'active' ||
        slot.browserQuarantined || slot.browserTabId !== tabId ||
        slot.browserState !== 'open' ||
        !workspace || workspace.status !== 'active' || workspace.slotId !== slotId) {
      throw new Error('Web patch requires an active bound task, tab and workspace');
    }
    const work = this.plane.organization.getWorkItem(task.organizationWorkItemId);
    const mission = this.plane.organization.getMission(work.missionId);
    const agent = work.ownerAgentId
      ? this.plane.organization.getAgent(work.ownerAgentId) : undefined;
    if (mission.projectId !== projectId || !agent ||
        agent.runtimeSlotId !== slotId ||
        !['ready', 'active'].includes(work.status) ||
        !['Developer', 'Tester'].includes(slot.role)) {
      throw new Error('Web patch role or Organization ownership does not match');
    }
    return { task, workspace, work, agent, slot };
  }

  preview(input: { projectId: string; taskId: string; slotId: string; tabId: number }): {
    headSha: string;
    files: WebPatchFile[];
    patchEnabled: boolean;
  } {
    const { workspace } = this.context(input.projectId, input.taskId, input.slotId, input.tabId);
    const observation = this.plane.workspaces.observe(workspace.id);
    if (observation.dirty) throw new Error('Web patch preview requires a clean worktree');

    const candidates: string[] = [];
    const walk = (directory: string, prefix: string, depth: number): void => {
      if (depth > 3 || candidates.length >= 100) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (candidates.length >= 100) return;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        let safe: string;
        try { safe = safeRelativePath(rel); } catch { continue; }
        if (entry.isDirectory()) {
          if (depth < 3) walk(join(directory, entry.name), safe, depth + 1);
        } else if (entry.isFile() &&
          /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py)$/i.test(entry.name) &&
          !/^(?:package-lock|yarn\.lock|pnpm-lock)\./i.test(entry.name)) {
          candidates.push(safe);
        }
      }
    };
    walk(workspace.path, '', 0);
    candidates.sort((a, b) =>
      (a.startsWith('test/') ? -1 : 0) - (b.startsWith('test/') ? -1 : 0) ||
      a.length - b.length || a.localeCompare(b));

    let remaining = MAX_CONTEXT_CHARS;
    const files: WebPatchFile[] = [];
    for (const path of candidates) {
      if (remaining < 120 || files.length >= 16) break;
      const file = fileInside(workspace.path, path);
      const content = readFileSync(file, 'utf8');
      if (content.length > 3500 || content.includes('\0')) continue;
      const chunk = content.slice(0, Math.min(content.length, remaining));
      files.push({ path, content: chunk });
      remaining -= chunk.length;
    }
    return { headSha: observation.headSha, files, patchEnabled: process.env.GAM_ALLOW_WEB_PATCHES === '1' };
  }

  apply(input: WebPatchRequest, now = Date.now()): WebPatchResult {
    if (process.env.GAM_ALLOW_WEB_PATCHES !== '1') {
      throw new Error('Web patching is disabled; set GAM_ALLOW_WEB_PATCHES=1 only for trusted projects');
    }
    const { task, workspace, work, agent, slot } =
      this.context(input.projectId, input.taskId, input.slotId, input.tabId);
    const attemptId = requireText(input.attemptId, 'attemptId', 128);
    const summary = requireText(input.summary, 'summary', 1000);
    const sourceSha = requireText(input.baseSha, 'baseSha', 64);
    const previous = this.plane.database.db.prepare(`
      SELECT type,payload_json FROM events
      WHERE project_id=? AND subject=? AND type IN ('ORG_WEB_PATCH_STARTED','ORG_WEB_PATCH_APPLIED')
      ORDER BY seq DESC LIMIT 1
    `).get(input.projectId, attemptId) as
      { type: string; payload_json: string } | undefined;
    if (previous?.type === 'ORG_WEB_PATCH_APPLIED') {
      const result = JSON.parse(previous.payload_json) as WebPatchResult;
      if (result.taskId !== input.taskId) throw new Error('Web patch replay identity mismatch');
      return result;
    }
    if (previous) throw new Error('Web patch attempt was interrupted; manual recovery required');

    const row = this.plane.database.db.prepare(
      'SELECT document_json FROM manager_attempts WHERE id=?',
    ).get(attemptId) as { document_json: string } | undefined;
    const attempt = row ? JSON.parse(row.document_json) as AttemptDocument : undefined;
    if (!attempt || attempt.attemptId !== attemptId ||
        attempt.taskId !== input.taskId || attempt.tabId !== input.tabId ||
        attempt.state !== 'reply-observed' || !task.attemptIds ||
        !(task.attemptIds as string[]).includes(attemptId) ||
        (slot.conversationKey && attempt.conversationKey !== slot.conversationKey)) {
      throw new Error('Web patch is not bound to a replied, durable task attempt');
    }

    const observation = this.plane.workspaces.observe(workspace.id);
    if (observation.dirty || observation.headSha !== sourceSha) {
      throw new Error('Web patch source Git SHA is stale or dirty');
    }

    if (!Array.isArray(input.files) || input.files.length > MAX_FILES ||
        (input.files.length === 0 && slot.role !== 'Tester')) {
      throw new Error('Web patch file count is invalid');
    }
    if (slot.role === 'Tester' && process.env.GAM_ALLOW_AGENT_TEST_RUNS !== '1') {
      throw new Error('Tester web patch requires operator-approved local test execution');
    }
    let total = 0;
    const names = new Set<string>();
    const writes = input.files.map((file) => {
      const path = safeRelativePath(file.path);
      if (names.has(path)) throw new Error('Web patch includes a duplicate file');
      names.add(path);
      if (typeof file.content !== 'string' || file.content.includes('\0')) {
        throw new Error('Web patch file content is invalid');
      }
      total += file.content.length;
      if (total > MAX_PATCH_CHARS) throw new Error('Web patch payload exceeds bounded reply size');
      return { path, target: fileInside(workspace.path, path), content: file.content };
    });

    this.plane.database.transaction(() => {
      const exists = this.plane.database.db.prepare(
        "SELECT seq FROM events WHERE project_id=? AND subject=? AND type='ORG_WEB_PATCH_STARTED'",
      ).get(input.projectId, attemptId);
      if (exists) throw new Error('Web patch attempt already started');
      this.plane.database.db.prepare(
        'INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(?,?,?,?,?)',
      ).run(input.projectId, 'ORG_WEB_PATCH_STARTED', attemptId,
        JSON.stringify({ taskId: input.taskId, slotId: input.slotId, sourceSha, files: [...names] }), now);
    });

    // SQLite event is written before filesystem effects. An interruption is
    // deliberately not replayed, because file writes and Git are not atomic.
    for (const write of writes) {
      mkdirSync(dirname(write.target), { recursive: true });
      // Recheck symlinks after directory creation.
      fileInside(workspace.path, write.path);
      writeFileSync(write.target, write.content, { encoding: 'utf8', flag: 'w' });
    }

    const gitPath = process.env.GAM_GIT_PATH || 'git';
    if (writes.length > 0) {
      git(workspace.path, ['add', '--', ...writes.map((item) => item.path)], gitPath);
      const hooks = join(dirname(this.plane.database.path), 'empty-git-hooks');
      mkdirSync(hooks, { recursive: true });
      git(workspace.path, [
        '-c', 'user.name=Charterion Web Worker',
        '-c', 'user.email=web-worker@example.invalid',
        '-c', `core.hooksPath=${hooks}`,
        'commit', '--no-gpg-sign', '-m', `charterion: ${input.taskId}`,
      ], gitPath);
    }
    const commitSha = git(workspace.path, ['rev-parse', 'HEAD'], gitPath);
    if (this.plane.workspaces.observe(workspace.id).dirty) {
      throw new Error('Web patch commit left a dirty worktree');
    }

    let result: WebPatchResult;
    if (slot.role === 'Tester') {
      const test = new OrganizationTestRunner(this.plane)
        .run(input.projectId, work.id);
      if (test.status !== 'passed') {
        result = {
          projectId: input.projectId, taskId: input.taskId, attemptId,
          status: 'test-failed', commitSha, testResultId: test.id,
        };
      } else {
        result = this.completeVerified(input, work.id, agent.id, workspace, commitSha, summary, now);
      }
    } else {
      result = this.completeVerified(input, work.id, agent.id, workspace, commitSha, summary, now);
    }
    this.plane.database.db.prepare(
      'INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(?,?,?,?,?)',
    ).run(input.projectId, 'ORG_WEB_PATCH_APPLIED', attemptId, JSON.stringify(result), now);
    return result;
  }

  private completeVerified(
    input: WebPatchRequest,
    workItemId: string,
    agentId: string,
    workspace: { id: string; resourceId: string; leaseEpoch: number },
    commitSha: string,
    summary: string,
    now: number,
  ): WebPatchResult {
    const claim = this.plane.evidence.submitClaim({
      projectId: input.projectId, taskId: input.taskId,
      subject: input.slotId, resourceId: workspace.resourceId,
      leaseEpoch: workspace.leaseEpoch, summary, commitSha,
    });
    const verification = this.plane.verifyClaimAndCompleteTask(claim.id, now);
    if (verification.status !== 'passed' || !this.plane.work.getTask(input.taskId)?.machineCompletion) {
      throw new Error('Web patch machine verification did not complete');
    }
    this.plane.ingress.completeWorkItem({
      workItemId, completedBy: agentId, summary,
      producedRefs: [`commit:${commitSha}`],
    }, now);
    try {
      new OrganizationReviewRelease(this.plane).reconcile(workItemId, now);
      new OrganizationWorkReconciler(this.plane).reconcile(input.projectId);
    } finally {
      // WorkOutcome is durable; release the scoped workspace only afterward.
      this.plane.releaseTaskWorkspace(workspace.id, now);
    }
    return {
      projectId: input.projectId, taskId: input.taskId, attemptId: input.attemptId,
      status: 'completed', commitSha, claimId: claim.id,
    };
  }
}
