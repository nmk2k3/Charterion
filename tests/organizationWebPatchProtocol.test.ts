import { describe, expect, it } from 'vitest';
import { WEB_PATCH_OPEN, WEB_PATCH_CLOSE, parseWebPatchReply } from '../src/organizationWebPatchProtocol';

const expected = { taskId: 'org-work-test', slotId: 'agent-slot', baseSha: 'a'.repeat(40) };
function reply(files: Array<{ path: string; content: string }> = [
  { path: 'src/feature.ts', content: 'export const ready = true;\n' },
]) {
  return `${WEB_PATCH_OPEN}\n${JSON.stringify({
    taskId: expected.taskId, slotId: expected.slotId, baseSha: expected.baseSha,
    summary: 'Implemented a scoped feature', files,
  })}\n${WEB_PATCH_CLOSE}`;
}

describe('strict ChatGPT Web patch response parser', () => {
  it('accepts one exact correlated terminal JSON response', () => {
    const result = parseWebPatchReply('Relevant explanation.\n'+reply(), expected);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.patch.files).toEqual([
        { path: 'src/feature.ts', content: 'export const ready = true;\n' },
      ]);
    }
  });
  it('does not treat ordinary prose as an executable patch', () => {
    expect(parseWebPatchReply('I have completed the task.', expected)).toEqual({ kind: 'absent' });
    expect(parseWebPatchReply('Patch example: const foo=1', expected)).toEqual({ kind: 'absent' });
  });
  it('rejects stale SHA or wrong recipient identity', () => {
    expect(parseWebPatchReply(reply(), { ...expected, baseSha: 'b'.repeat(40) }).kind).toBe('invalid');
    expect(parseWebPatchReply(reply(), { ...expected, slotId: 'other' }).kind).toBe('invalid');
  });
  it('rejects ambiguous, trailing or fenced model outputs', () => {
    expect(parseWebPatchReply(reply() + '\nExtra payload', expected).kind).toBe('invalid');
    expect(parseWebPatchReply(reply() + '\n' + reply(), expected).kind).toBe('invalid');
    expect(parseWebPatchReply(WEB_PATCH_OPEN + '\n' + '```json\n{}\n```' + '\n' + WEB_PATCH_CLOSE, expected).kind).toBe('invalid');
  });
  it('rejects symlink traversal-like paths and duplicate paths', () => {
    expect(parseWebPatchReply(reply([{ path: '../secrets.txt', content: 'x' }]), expected).kind).toBe('invalid');
    expect(parseWebPatchReply(reply([{ path: '.git/config', content: 'x' }]), expected).kind).toBe('invalid');
    expect(parseWebPatchReply(reply([{ path: 'src/one.ts', content: 'x' }, { path: 'src/one.ts', content: 'y' }]), expected).kind).toBe('invalid');
  });
  it('enforces output size and exact JSON fields', () => {
    expect(parseWebPatchReply(reply([{ path: 'src/long.ts', content: 'a'.repeat(10_001) }]), expected).kind).toBe('invalid');
    const output = reply().replace('"summary":', '"isAdmin":true,"summary":');
    expect(parseWebPatchReply(output, expected).kind).toBe('invalid');
  });
  it('permits zero-file Tester responses (backend decides role)', () => {
    const result = parseWebPatchReply(reply([]), expected);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') expect(result.patch.files).toHaveLength(0);
  });
});
