// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Moves recorded by move edits, so the output can print `R old -> new` lines. */
let moves: Array<[string, string]> = [];

/** A file as lines plus its own line break and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  ends: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let ends = false;
  if (text.endsWith(br)) {
    lines.pop();
    ends = true;
  }
  return { lines, br, ends };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}
function lineMatch(a: string, b: string, tier: number): boolean {
  return normLine(a, tier) === normLine(b, tier);
}

/** 0-based positions where `o` occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineMatch(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, 1, 2; only 0 when strict) at which `o` occurs in `lines`
 * at or after `from`, and its positions there. With `endAnchored` only
 * occurrences ending at the file's last line count (SPEC.md sections 5 and 8).
 */
function findOcc(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
  endAnchored = false,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let ps = occurrences(lines, o, t, from);
    if (endAnchored) ps = ps.filter((i) => i + o.length === lines.length);
    if (ps.length > 0) return { tier: t, pos: ps };
  }
  return null;
}

/** One line of N: a context line (written as the file's own line at its O index) or a new line. */
interface NewItem {
  text: string;
  ctx: number | null;
}

/** Build N for a replacement at `pos` (SPEC.md section 5: context lines from the file, tier-2 re-indent). */
function buildNew(fileLines: string[], pos: number, o: string[], n: NewItem[], tier: number): string[] {
  const out: string[] = [];
  const f = o.length > 0 ? leadOf(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadOf(o[0]!) : '';
  for (const it of n) {
    if (it.ctx !== null) out.push(fileLines[pos + it.ctx]!);
    else if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(p)) out.push(f + it.text.slice(p.length));
    else out.push(it.text);
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk. `backslash` marks a `\` line after it. */
interface BodyItem {
  kind: string;
  text: string;
  backslash: boolean;
  rawEmpty: boolean;
}

/** Split body items into O lines and N items (context lines carry their O index). */
function splitBody(body: BodyItem[]): { o: string[]; n: NewItem[]; lastCtxPlus: BodyItem | null } {
  const o: string[] = [];
  const n: NewItem[] = [];
  let lastCtxPlus: BodyItem | null = null;
  for (const it of body) {
    if (it.kind === ' ') {
      n.push({ text: it.text, ctx: o.length });
      o.push(it.text);
      lastCtxPlus = it;
    } else if (it.kind === '-') {
      o.push(it.text);
    } else if (it.kind === '+') {
      n.push({ text: it.text, ctx: null });
      lastCtxPlus = it;
    }
  }
  return { o, n, lastCtxPlus };
}

interface Hunk {
  a: number;
  body: BodyItem[];
  oLen: number;
  nLen: number;
}

interface UniSection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameOld: string | null | undefined;
  renameNew: string | null | undefined;
  gitOld: string;
  gitNew: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path after `--- `/`+++ `: up to the first tab, surrounding spaces removed, `a/`/`b/` stripped. */
function diffPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const body: BodyItem[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l === 'diff --git' || l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      if (l.startsWith('\\')) {
        const prev = body[body.length - 1];
        if (prev !== undefined) prev.backslash = true;
      } else if (l === '') {
        body.push({ kind: ' ', text: '', backslash: false, rawEmpty: true });
      } else {
        body.push({ kind: l[0]!, text: l.slice(1), backslash: false, rawEmpty: false });
      }
      j++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
  let oLen = 0;
  let nLen = 0;
  for (const it of body) {
    if (it.kind === ' ' || it.kind === '-') oLen++;
    if (it.kind === ' ' || it.kind === '+') nLen++;
  }
  return { hunk: { a, body, oLen, nLen }, next: j };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (gitOld: string, gitNew: string): UniSection => {
    const s: UniSection = {
      oldPath: undefined, newPath: undefined, renameOld: undefined, renameNew: undefined,
      gitOld, gitNew, create: false, del: false, hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (!inHeader && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = newSection('', '');
      s.oldPath = diffPath(line);
      s.newPath = diffPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(lines, i);
      cur.hunks.push(r.hunk);
      inHeader = false;
      i = r.next;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.oldPath = diffPath(line);
          cur.newPath = diffPath(lines[i + 1]!);
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = diffPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

/** Apply one hunk to `file`; returns N's length minus O's length (the section's running `d`). */
function applyHunk(file: FileModel, hunk: Hunk, d: number, strict: boolean, path: string): number {
  const { o, n, lastCtxPlus } = splitBody(hunk.body);
  const noEol = lastCtxPlus !== null && lastCtxPlus.backslash;
  if (o.length === 0) {
    const pos = Math.min(Math.max(hunk.a + d, 0), file.lines.length);
    const atEnd = pos === file.lines.length;
    file.lines.splice(pos, 0, ...n.map((it) => it.text));
    if (atEnd) file.ends = !noEol;
    return hunk.nLen - hunk.oLen;
  }
  const found = findOcc(file.lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const touchesEnd = best + o.length === file.lines.length;
  const repl = buildNew(file.lines, best, o, n, found.tier);
  file.lines.splice(best, o.length, ...repl);
  if (touchesEnd) file.ends = !noEol;
  return hunk.nLen - hunk.oLen;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    return (tree: Tree) => {
      const oldU = sec.oldPath !== undefined ? sec.oldPath : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld === '' ? undefined : sec.gitOld;
      const newU = sec.newPath !== undefined ? sec.newPath : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew === '' ? undefined : sec.gitNew;
      const oldP = oldU === undefined ? (newU === undefined ? null : newU) : oldU;
      const newP = newU === undefined ? (oldU === undefined ? null : oldU) : newU;
      if (sec.create || oldP === null) {
        const p = newP;
        if (p === null) throw new Fail('unsafe', '');
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let lastPlus: BodyItem | null = null;
        for (const h of sec.hunks) {
          for (const it of h.body) {
            if (it.kind === '+') {
              plus.push(it.text);
              lastPlus = it;
            }
          }
        }
        const noEol = lastPlus !== null && lastPlus.backslash;
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (sec.del || newP === null) {
        const p = oldP;
        if (p === null) throw new Fail('unsafe', '');
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (oldP === null || newP === null) throw new Fail('unsafe', '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      const isMove = oldP !== newP;
      if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
      const file = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) d += applyHunk(file, h, d, strict, oldP);
      const text = serializeFile(file);
      if (isMove) {
        tree.now.set(oldP, null);
        tree.now.set(newP, text);
        moves.push([oldP, newP]);
      } else {
        tree.now.set(oldP, text);
      }
    };
  });
}

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchNo = i + 1;
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchNo}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchNo}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevReplace = end;
    i = end;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const file = parseFile(before);
      const found = findOcc(file.lines, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.pos[0]!;
      const nItems: NewItem[] = b.newLines.map((t) => ({ text: t, ctx: null }));
      const repl = buildNew(file.lines, pos, b.oldLines, nItems, found.tier);
      file.lines.splice(pos, b.oldLines.length, ...repl);
      tree.now.set(b.path, serializeFile(file));
    };
  });
}

interface V4aChunk {
  anchor: string;
  items: BodyItem[];
  eof: boolean;
}

interface V4aSection {
  kind: string;
  path: string;
  lineNo: number;
  raw: Array<{ text: string; no: number }>;
}

const V4A_HEADER_RE = /^\*\*\* (Add File|Delete File|Update File):(.*)$/;

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const m = V4A_HEADER_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerNo = i + 1;
    const raw: Array<{ text: string; no: number }> = [];
    i++;
    while (i < last) {
      const l = lines[i]!;
      if (V4A_HEADER_RE.test(l)) break;
      raw.push({ text: l, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    sections.push({ kind: m[1]!, path: m[2]!.trim(), lineNo: headerNo, raw });
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function v4aAddLines(sec: V4aSection): string[] {
  const out: string[] = [];
  for (const { text, no } of sec.raw) {
    if (text === '') out.push('');
    else if (text.startsWith('+')) out.push(text.slice(1));
    else throw new Exit2(`error: parse ${no}`);
  }
  return out;
}

function v4aUpdate(sec: V4aSection): { moveTo: string | null; chunks: V4aChunk[] } {
  const raw = sec.raw;
  let idx = 0;
  while (idx < raw.length && blank(raw[idx]!.text)) idx++;
  let moveTo: string | null = null;
  if (idx < raw.length && raw[idx]!.text.startsWith('*** Move to:')) {
    moveTo = raw[idx]!.text.slice('*** Move to:'.length).trim();
    idx++;
    while (idx < raw.length && blank(raw[idx]!.text)) idx++;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let eofClosed = false;
  for (; idx < raw.length; idx++) {
    const { text, no } = raw[idx]!;
    if (eofClosed) {
      if (blank(text)) continue;
      throw new Exit2(`error: parse ${no}`);
    }
    if (text.startsWith('@@')) {
      cur = { anchor: text.slice(2).trim(), items: [], eof: false };
      chunks.push(cur);
    } else if (text === '*** End of File') {
      if (cur === null) {
        cur = { anchor: '', items: [], eof: true };
        chunks.push(cur);
      } else {
        cur.eof = true;
      }
      eofClosed = true;
    } else if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        cur = { anchor: '', items: [], eof: false };
        chunks.push(cur);
      }
      cur.items.push({ kind: text === '' ? ' ' : text[0]!, text: text === '' ? '' : text.slice(1), backslash: false, rawEmpty: text === '' });
    } else {
      throw new Exit2(`error: parse ${no}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
  return { moveTo, chunks };
}

function applyV4aChunk(file: FileModel, chunk: V4aChunk, cursor: { v: number }, strict: boolean, path: string): void {
  if (chunk.anchor !== '') {
    const found = findOcc(file.lines, [chunk.anchor], strict, cursor.v);
    if (found === null) throw new Fail('no-match', path);
    cursor.v = found.pos[0]! + 1;
  }
  const { o, n } = splitBody(chunk.items);
  if (o.length === 0) {
    const pos = chunk.eof ? file.lines.length : cursor.v;
    const ins = n.map((it) => it.text);
    file.lines.splice(pos, 0, ...ins);
    cursor.v = pos + ins.length;
    return;
  }
  const found = findOcc(file.lines, o, strict, cursor.v, chunk.eof);
  if (found === null) throw new Fail('no-match', path);
  const pos = found.pos[0]!;
  const repl = buildNew(file.lines, pos, o, n, found.tier);
  file.lines.splice(pos, o.length, ...repl);
  cursor.v = pos + repl.length;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((sec) => {
    if (sec.kind === 'Add File') {
      const content = v4aAddLines(sec);
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, content.length === 0 ? '' : content.join('\n') + '\n');
      };
    }
    if (sec.kind === 'Delete File') {
      for (const { text, no } of sec.raw) {
        if (!blank(text)) throw new Exit2(`error: parse ${no}`);
      }
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    const upd = v4aUpdate(sec);
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (upd.moveTo !== null && !safe(upd.moveTo)) throw new Fail('unsafe', upd.moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (upd.moveTo !== null && tree.get(upd.moveTo) !== null) throw new Fail('exists', upd.moveTo);
      const file = parseFile(before);
      const cursor = { v: 0 };
      for (const chunk of upd.chunks) applyV4aChunk(file, chunk, cursor, strict, sec.path);
      const text = serializeFile(file);
      if (upd.moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(upd.moveTo, text);
        moves.push([sec.path, upd.moveTo]);
      } else {
        tree.now.set(sec.path, text);
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  moves = [];
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const [oldP, newP] of moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (wasOld === null || nowOld !== null || wasNew !== null || nowNew === null) continue;
    const di = rows.findIndex((r) => r.text === `D ${oldP}`);
    const ai = rows.findIndex((r) => r.text === `A ${newP}`);
    if (di < 0 || ai < 0) continue;
    rows.splice(Math.max(di, ai), 1);
    rows.splice(Math.min(di, ai), 1);
    rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
