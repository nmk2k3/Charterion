import { describe, expect, it } from 'vitest';
import {
  WEB_REVIEW_OPEN, WEB_REVIEW_CLOSE, parseWebReviewReply,
} from '../src/organizationWebReviewProtocol';
import { STRUCTURED_RESULT_OPEN, STRUCTURED_RESULT_CLOSE } from '../src/structuredResult';

const identity = {
  taskId: 'org-work-r1', slotId: 'slot-reviewer',
  reviewSlotId: 'review-slot-1', headSha: 'a'.repeat(40),
};
function text(
  decision: 'approve' | 'request-changes' | 'reject' = 'approve',
  note = 'Inspected the exact diff and passing test evidence',
) {
  const review = { ...identity, decision, note };
  const result = {
    status: 'completed', summary: note,
    evidence: [`commit:${identity.headSha}`, `review-slot:${identity.reviewSlotId}`],
  };
  return `${WEB_REVIEW_OPEN}\n${JSON.stringify(review)}\n${WEB_REVIEW_CLOSE}\n${STRUCTURED_RESULT_OPEN}\n${JSON.stringify(result)}\n${STRUCTURED_RESULT_CLOSE}`;
}

describe('AI Review protocol', () => {
  it('accepts an exact independent approval with terminal evidence', () => {
    expect(parseWebReviewReply(text(), identity)).toMatchObject({
      kind: 'ready', review: { ...identity, decision: 'approve' },
    });
  });
  it('supports rejecting or requesting changes', () => {
    expect(parseWebReviewReply(text('reject'), identity).kind).toBe('ready');
    expect(parseWebReviewReply(text('request-changes'), identity).kind).toBe('ready');
  });
  it('does not execute arbitrary model prose', () => {
    expect(parseWebReviewReply('I approve the change.', identity)).toEqual({ kind: 'absent' });
  });
  it('rejects stale commit, wrong reviewer and wrong slot', () => {
    expect(parseWebReviewReply(text(), { ...identity, headSha: 'b'.repeat(40) }).kind).toBe('invalid');
    expect(parseWebReviewReply(text(), { ...identity, slotId: 'another' }).kind).toBe('invalid');
    expect(parseWebReviewReply(text(), { ...identity, reviewSlotId: 'another' }).kind).toBe('invalid');
  });
  it('rejects ambiguous or unsupported payloads', () => {
    expect(parseWebReviewReply(text() + '\nextra', identity).kind).toBe('invalid');
    expect(parseWebReviewReply(text() + '\n' + text(), identity).kind).toBe('invalid');
    const invalid = text().replace('"decision":"approve"', '"decision":"force-merge"');
    expect(parseWebReviewReply(invalid, identity).kind).toBe('invalid');
  });
  it('requires exact structured evidence for the selected commit and slot', () => {
    const noEvidence = text().replace(`commit:${identity.headSha}`, 'commit:wrong');
    expect(parseWebReviewReply(noEvidence, identity).kind).toBe('invalid');
  });
});
