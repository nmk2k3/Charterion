export const WEB_PATCH_OPEN = '<<<CHARTERION_PATCH_V1>>>';
export const WEB_PATCH_CLOSE = '<<<END_CHARTERION_PATCH_V1>>>';
export const MAX_WEB_PATCH_REPLY_CHARS = 11_500;
export const MAX_WEB_PATCH_FILE_CHARS = 10_000;

export interface ParsedWebPatch {
  taskId: string;
  slotId: string;
  baseSha: string;
  summary: string;
  files: Array<{ path: string; content: string }>;
}

export type WebPatchParseResult =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ready'; patch: ParsedWebPatch };

const PATH = /^[a-zA-Z0-9_.@+()/-]{1,220}$/;
const PROTECTED = new Set(['.git', 'node_modules', '.env', '.ssh', '.npmrc',
  'dist', 'dist-control', 'dist-native-host', 'capabilities', '.gitignore.lock']);

export function parseWebPatchReply(
  text: string,
  expected: { taskId: string; slotId: string; baseSha: string },
): WebPatchParseResult {
  if (!text.includes(WEB_PATCH_OPEN) && !text.includes(WEB_PATCH_CLOSE)) {
    return { kind: 'absent' };
  }
  const invalid = (reason: string): WebPatchParseResult => ({ kind: 'invalid', reason });
  if (text.length > MAX_WEB_PATCH_REPLY_CHARS) return invalid('Web patch reply exceeds maximum size');

  const start = text.lastIndexOf(WEB_PATCH_OPEN);
  const close = text.lastIndexOf(WEB_PATCH_CLOSE);
  if (start < 0 || close < 0 || close < start ||
      text.indexOf(WEB_PATCH_OPEN) !== start ||
      text.indexOf(WEB_PATCH_CLOSE) !== close ||
      text.slice(close + WEB_PATCH_CLOSE.length).trim() !== '') {
    return invalid('Web patch requires one unambiguous terminal marker pair');
  }
  const raw = text.slice(start + WEB_PATCH_OPEN.length, close).trim();
  if (raw.startsWith('```') || raw.length > MAX_WEB_PATCH_REPLY_CHARS - 100) {
    return invalid('Web patch JSON must not use Markdown code fences');
  }

  let object: unknown;
  try { object = JSON.parse(raw) as unknown; }
  catch { return invalid('Web patch payload is not valid JSON'); }
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    return invalid('Web patch JSON must be an object');
  }

  const value = object as Record<string, unknown>;
  const names = Object.keys(value);
  const expectedKeys = ['taskId', 'slotId', 'baseSha', 'summary', 'files'];
  if (names.length !== expectedKeys.length ||
      !expectedKeys.every((name) => Object.hasOwn(value, name))) {
    return invalid('Web patch JSON contains missing or unknown fields');
  }
  if (value.taskId !== expected.taskId ||
      value.slotId !== expected.slotId ||
      value.baseSha !== expected.baseSha) {
    return invalid('Web patch task/slot/Git SHA does not match the assigned prompt');
  }
  if (typeof value.summary !== 'string' ||
      !value.summary.trim() ||
      value.summary.length > 1000) {
    return invalid('Web patch summary is missing or too long');
  }
  if (!Array.isArray(value.files) || value.files.length > 8) {
    return invalid('Web patch file list exceeds the allowed limit');
  }

  const seen = new Set<string>();
  let total = 0;
  const files: ParsedWebPatch['files'] = [];
  for (const item of value.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return invalid('Web patch file entry is not an object');
    }
    const file = item as Record<string, unknown>;
    if (Object.keys(file).length !== 2 ||
        !Object.hasOwn(file, 'path') || !Object.hasOwn(file, 'content') ||
        typeof file.path !== 'string' || typeof file.content !== 'string') {
      return invalid('Web patch file must contain exactly path/content');
    }
    const path = file.path;
    if (!PATH.test(path) || path.startsWith('/') ||
        path.includes('//') || path.includes('\\') ||
        path.split('/').some((seg) => !seg || seg === '.' || seg === '..' ||
          PROTECTED.has(seg.toLowerCase()) || seg.toLowerCase().startsWith('.env.'))) {
      return invalid('Web patch filename is unsafe');
    }
    if (seen.has(path)) return invalid('Web patch contains repeated paths');
    seen.add(path);
    if (file.content.includes('\0')) return invalid('Web patch contains invalid file content');
    total += file.content.length;
    if (total > MAX_WEB_PATCH_FILE_CHARS) return invalid('Web patch file data is too large');
    files.push({ path, content: file.content });
  }
  return { kind: 'ready', patch: {
    taskId: value.taskId as string,
    slotId: value.slotId as string,
    baseSha: value.baseSha as string,
    summary: (value.summary as string).trim(),
    files,
  } };
}
