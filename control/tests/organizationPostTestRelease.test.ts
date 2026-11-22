import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';
import { RpcRouter } from '../src/rpc';
import { OrganizationTestRunner } from '../src/organizationTestRunner';
import { OrganizationReviewRelease } from '../src/organizationReviewRelease';
import { assertOrganizationPromotionReady } from '../src/organizationReviewGate';

const gitPath = process.env.GAM_GIT_PATH || 'git';
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(gitPath, ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 15000, windowsHide: true, shell: false,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'git failed');
  return result.stdout.trim();
}

describe('post-Test organization review and promotion', () => {
  it('requires exact Tester evidence, releases reviewer work, promotes after independent decisions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'org-review-release-'));
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'test'), { recursive: true });
    let db: ControlDatabase | undefined;
    try {
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.name', 'Charterion');
      git(repo, 'config', 'user.email', 'test@example.invalid');
      writeFileSync(join(repo, 'sum.mjs'), 'export const sum = (a,b) => a + b;\n');
      writeFileSync(join(repo, 'test', 'sum.test.mjs'),
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {sum} from '../sum.mjs';\ntest('sum',()=>assert.equal(sum(1,2),3));\n");
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'baseline');
      const baseSha = git(repo, 'rev-parse', 'HEAD');

      db = new ControlDatabase(join(dir, 'state.db'));
      const plane = new ControlPlane(db);
      const router = new RpcRouter(plane, 'admin', 'browser');
      const project = plane.createProject({ name: 'Release Project', rootPath: repo, maxSlots: 12 });
      const org = plane.organization.createOrganization({ name: 'Engineering' });

      function worker(role: 'Developer' | 'Tester') {
        const agent = plane.organization.registerAgent({ organizationId: org.id, displayName: role });
        const agentWorkspace = plane.organization.activeAgentWorkspace(agent.id)!;
        plane.organization.configureAgentWorkspace({
          workspaceId: agentWorkspace.id,
          rootRef: repo, browserProfileId: `browser-${agent.id}`, toolProfileRef: `tools-${agent.id}`,
        });
        const acquisition = plane.organizationRuntime.requestAndAcquire({
          organizationId: org.id, agentId: agent.id, projectId: project.id,
          role, idempotencyKey: `runtime-${role}`,
        });
        return { agent, slotId: acquisition.runtimeSlotId! };
      }
      const developer = worker('Developer');
      const tester = worker('Tester');
      const mission = plane.organization.createMission({
        organizationId: org.id, projectId: project.id,
        title: 'Fix, test and release', objective: 'Review only after passed Tester outcome',
        driAgentId: developer.agent.id,
      });
      plane.organization.setMissionStatus(mission.id, 'active');

      const devWork = plane.organization.createWorkItem({
        missionId: mission.id, title: 'Implementation', objective: 'Implement feature',
        ownerAgentId: developer.agent.id, completionPolicy: 'verified-claim',
      });
      const testWork = plane.organization.createWorkItem({
        missionId: mission.id, title: 'Quality assurance', objective: 'Verify implementation',
        ownerAgentId: tester.agent.id, completionPolicy: 'verified-claim', dependsOn: [devWork.id],
      });

      const completion = (workItemId: string, agentId: string, capability?: string) => {
        const response = router.handle({
          id: `complete-${workItemId}`,
          method: 'org-work.complete',
          auth: capability ? { capabilityToken: capability } : { adminToken: 'admin' },
          params: { workItemId, completedBy: agentId, summary: 'Verified result accepted' },
        });
        expect(response.ok).toBe(true);
        if (!response.ok) throw new Error(response.error.message);
        return response.result as Record<string, unknown>;
      };
      const verify = (workItemId: string, slotId: string, workspace: { path: string; resourceId: string; leaseEpoch: number }) => {
        const sha = git(workspace.path, 'rev-parse', 'HEAD');
        const claim = plane.evidence.submitClaim({
          projectId: project.id, taskId: `org-work-${workItemId}`,
          subject: slotId, resourceId: workspace.resourceId, leaseEpoch: workspace.leaseEpoch,
          summary: 'Exact-head verified claim', commitSha: sha,
        });
        const proof = plane.verifyClaimAndCompleteTask(claim.id);
        expect(proof.status).toBe('passed');
        return { claim, sha };
      };

      plane.organization.setWorkStatus(devWork.id, 'ready');
      plane.organizationExecution.materialize(devWork.id);
      const devWorkspace = plane.provisionTaskWorkspace(project.id, developer.slotId, `org-work-${devWork.id}`);
      writeFileSync(join(devWorkspace.path, 'feature.txt'), 'real feature\n');
      git(devWorkspace.path, 'add', 'feature.txt');
      git(devWorkspace.path, 'commit', '-m', 'feat: implement');
      const devProof = verify(devWork.id, developer.slotId, devWorkspace);

      expect(plane.reviewPool.queueForAgent(developer.agent.id)).toEqual([]);
      expect(Number(db.db.prepare('SELECT count(*) AS n FROM review_requests').get()?.n)).toBe(0);
      completion(devWork.id, developer.agent.id);
      expect(plane.organization.getWorkItem(testWork.id).status).toBe('ready');

      const testWorkspace = plane.provisionTaskWorkspace(project.id, tester.slotId, `org-work-${testWork.id}`);
      expect(testWorkspace.baseSha).toBe(devProof.sha);
      writeFileSync(join(testWorkspace.path, 'test-proof.txt'), 'passed exact commit\n');
      git(testWorkspace.path, 'add', 'test-proof.txt');
      git(testWorkspace.path, 'commit', '-m', 'test: evidence commit');

      const result = new OrganizationTestRunner(plane).run(project.id, testWork.id);
      expect(result.status).toBe('passed');
      const testProof = verify(testWork.id, tester.slotId, testWorkspace);
      expect(result.commitSha).toBe(testProof.sha);
      expect(Number(db.db.prepare('SELECT count(*) AS n FROM review_requests').get()?.n)).toBe(0);

      expect(() => assertOrganizationPromotionReady(db!, testProof.claim.id, project.id, testProof.sha))
        .toThrow(/Reviewer Gate/);
      expect(plane.workspaces.get(testWorkspace.id).status).toBe('active');

      // The scoped Tester capability can complete only its own WorkItem.
      const token = readFileSync(testWorkspace.capabilityTokenPath, 'utf8').trim();
      const released = completion(testWork.id, tester.slotId, token);
      expect(released.reviewRelease).toMatchObject({ status: 'review-ready' });
      expect(plane.workspaces.get(testWorkspace.id).status).toBe('released');
      expect(plane.organization.getMission(mission.id).status).toBe('active');

      const requests = db.db.prepare('SELECT id FROM review_requests').all() as Array<{id: string}>;
      expect(requests).toHaveLength(1);
      const requestId = requests[0]!.id;
      const slots = plane.reviewPool.listSlots(requestId);
      expect(slots).toHaveLength(2);
      expect(git(repo, 'rev-parse', 'refs/heads/main')).toBe(baseSha);

      const repeated = new OrganizationReviewRelease(plane).reconcile(testWork.id);
      expect(repeated.status).toBe('review-ready');
      expect(Number(db.db.prepare('SELECT count(*) AS n FROM review_requests').get()?.n)).toBe(1);

      for (const slot of slots) {
        const row = db.db.prepare(
          'SELECT reviewer_agent_id FROM organization_review_work_items WHERE review_slot_id=?',
        ).get(slot.id) as { reviewer_agent_id: string };
        plane.reviewPool.claim({ slotId: slot.id, reviewerAgentId: row.reviewer_agent_id });
        const decision = plane.reviewPool.decide({
          slotId: slot.id, reviewerAgentId: row.reviewer_agent_id,
          decision: 'approve', note: 'Evidence and exact SHA inspected',
        });
        if (decision.request.status === 'approved') {
          const promoted = plane.organizationWorkflow.reconcileReviewDecision(requestId);
          expect(promoted.status).toBe('promoted');
        }
      }

      expect(git(repo, 'rev-parse', 'refs/heads/main')).toBe(testProof.sha);
      expect(plane.organization.getMission(mission.id).status).toBe('completed');
      expect(Number(db.db.prepare(
        "SELECT count(*) AS n FROM organization_review_work_items WHERE status='completed'",
      ).get()?.n)).toBe(2);
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
