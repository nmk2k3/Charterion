import { parseStructuredTaskResult, STRUCTURED_RESULT_OPEN } from './structuredResult';

export const WEB_REVIEW_OPEN = '<<<CHARTERION_REVIEW_V1>>>';
export const WEB_REVIEW_CLOSE = '<<<END_CHARTERION_REVIEW_V1>>>';

export interface ParsedWebReview {
  taskId: string;
  slotId: string;
  reviewSlotId: string;
  headSha: string;
  decision: 'approve' | 'request-changes' | 'reject';
  note: string;
}

export type WebReviewParseResult =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ready'; review: ParsedWebReview };

export function parseWebReviewReply(
  text: string,
  expected: { taskId: string; slotId: string; reviewSlotId: string; headSha: string },
): WebReviewParseResult {
  if (!text.includes(WEB_REVIEW_OPEN) && !text.includes(WEB_REVIEW_CLOSE)) {
    return { kind: 'absent' };
  }
  const invalid = (reason: string): WebReviewParseResult => ({ kind: 'invalid', reason });
  if (text.length > 12_000) return invalid('Web review output is too large');
  const begin = text.indexOf(WEB_REVIEW_OPEN);
  const end = text.indexOf(WEB_REVIEW_CLOSE);
  if (begin < 0 || end <= begin ||
      text.lastIndexOf(WEB_REVIEW_OPEN) !== begin ||
      text.lastIndexOf(WEB_REVIEW_CLOSE) !== end) {
    return invalid('Web review must contain one unambiguous marker pair');
  }
  const tail = text.slice(end + WEB_REVIEW_CLOSE.length).trim();
  if (!tail.startsWith(STRUCTURED_RESULT_OPEN) ||
      text.indexOf(STRUCTURED_RESULT_OPEN) !== end + WEB_REVIEW_CLOSE.length + text.slice(end + WEB_REVIEW_CLOSE.length).indexOf(STRUCTURED_RESULT_OPEN)) {
    return invalid('Web review must end with one structured result after its decision');
  }
  const structured = parseStructuredTaskResult(tail);
  if (!structured.ok) return invalid(structured.error);

  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(begin + WEB_REVIEW_OPEN.length, end).trim()); }
  catch { return invalid('Web review decision is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid('Web review decision must be an object');
  }
  const review = parsed as Record<string, unknown>;
  const keys = ['taskId','slotId','reviewSlotId','headSha','decision','note'];
  if (Object.keys(review).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(review, key))) {
    return invalid('Web review contains missing or unknown fields');
  }
  if (review.taskId !== expected.taskId || review.slotId !== expected.slotId ||
      review.reviewSlotId !== expected.reviewSlotId || review.headSha !== expected.headSha) {
    return invalid('Web review task, reviewer, review slot or commit is stale');
  }
  if (!['approve','request-changes','reject'].includes(String(review.decision)) ||
      typeof review.note !== 'string' || review.note.trim().length < 12 ||
      review.note.length > 1_000) {
    return invalid('Web review decision or evidence note is invalid');
  }
  if (structured.result.summary !== review.note.trim() ||
      !structured.result.evidence.includes(`commit:${expected.headSha}`) ||
      !structured.result.evidence.includes(`review-slot:${expected.reviewSlotId}`)) {
    return invalid('Structured review evidence does not match exact commit and slot');
  }
  return {
    kind: 'ready',
    review: {
      taskId: review.taskId as string,
      slotId: review.slotId as string,
      reviewSlotId: review.reviewSlotId as string,
      headSha: review.headSha as string,
      decision: review.decision as ParsedWebReview['decision'],
      note: review.note.trim(),
    },
  };
}
