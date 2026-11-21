
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';

describe('Verified Work Result Guard', () => {
  it('rejects an unverified completion and direct status bypass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'result-guard-'));
    const db = new ControlDatabase(join(dir, 'state.db'));

    try {
      const plane = new ControlPlane(db);
      const org = plane.organization.createOrganization({
        name: 'Engineering',
      });

      const agent = plane.organization.registerAgent({
        organizationId: org.id,
        displayName: 'Developer',
      });

      const mission = plane.organization.createMission({
        organizationId: org.id,
        title: 'Verification test',
        objective: 'Prevent false completion',
        driAgentId: agent.id,
      });

      plane.organization.setMissionStatus(
        mission.id,
        'active',
      );

      const work = plane.organization.createWorkItem({
        missionId: mission.id,
        title: 'Implement',
        objective: 'Produce verified code',
        ownerAgentId: agent.id,
        completionPolicy: 'verified-claim',
      });

      expect(() =>
        plane.ingress.completeWorkItem({
          workItemId: work.id,
          completedBy: agent.id,
          summary: 'Done without evidence',
        }),
      ).toThrow(/Verified work result rejected/);

      expect(() =>
        plane.organization.setWorkStatus(
          work.id,
          'completed',
        ),
      ).toThrow(/WorkItem completion requires/);

      expect(
        plane.organization.getWorkItem(work.id).status,
      ).toBe('proposed');

      expect(
        plane.ingress.getOutcome(work.id),
      ).toBeUndefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
