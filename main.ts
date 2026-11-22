// main.ts is mend, the CLI SPEC.md specifies (version 1). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 of SPEC.md come from the kit's starter: the command line, the output
// and exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. Sections
// 5 to 8 are implemented here: line matching at three tiers, unified diffs, SEARCH/REPLACE blocks
// and V4A patches, plus the `R old -> new` output line for moves.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** A file's text as lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, so the output can print `R old -> new` lines. */
  readonly moves: Array<[string, string]> = [];
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

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

function normAt(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where O occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normAt(lines[i + j]!, tier) !== normAt(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0..maxTier) at which O occurs at or after `from`, with its occurrences. */
function findAtTier(lines: string[], o: string[], maxTier: number, from = 0): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (the file's own matched line) or a new line's text. */
type NLine = { ctx: number } | { text: string };

/** The lines N writes when it replaces O at `at`: context lines are the file's own matched
 * lines; at tier 2 every other line is re-indented from O's first line's indent to the file's. */
function buildNew(state: FileState, at: number, o: string[], n: NLine[], tier: number): string[] {
  const f = o.length > 0 ? leadingWs(state.lines[at] ?? '') : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  return n.map((e) => {
    if ('ctx' in e) return state.lines[at + e.ctx]!;
    let t = e.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    return t;
  });
}

/** `state` with O at `at` replaced by N; `finalBreak` is the result's final line break. */
function applyAt(state: FileState, at: number, o: string[], n: NLine[], tier: number, finalBreak: boolean): FileState {
  const repl = buildNew(state, at, o, n, tier);
  const lines = [...state.lines.slice(0, at), ...repl, ...state.lines.slice(at + o.length)];
  return { lines, br: state.br, finalBreak };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits (from the kit's starter).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface UBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bslash';
  text: string;
}
interface UHunk {
  a: number;
  body: UBodyLine[];
  /** a `\` line follows the hunk's last context or `+` line. */
  noFinalBreak: boolean;
}
interface USection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed, a leading
 * `a/` or `b/` removed. */
function cleanDiffPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { pairOld: null, pairNew: null, renameOld: null, renameNew: null, diffOld: m[1]!, diffNew: m[2]!, create: false, del: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: UBodyLine[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') body.push({ kind: 'ctx', text: '' });
        else if (bl.startsWith(' ')) body.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl.startsWith('-')) body.push({ kind: 'old', text: bl.slice(1) });
        else if (bl.startsWith('+')) body.push({ kind: 'new', text: bl.slice(1) });
        else if (bl.startsWith('\\')) body.push({ kind: 'bslash', text: bl.slice(1) });
        else break;
        i++;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      let noFinalBreak = false;
      for (let j = body.length - 1; j >= 0; j--) {
        if (body[j]!.kind === 'ctx' || body[j]!.kind === 'new') {
          noFinalBreak = body[j + 1] !== undefined && body[j + 1]!.kind === 'bslash';
          break;
        }
      }
      cur.hunks.push({ a, body, noFinalBreak });
      inHeader = false;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (inHeader && cur !== null) {
        if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.pairOld = cleanDiffPath(line.slice(4));
        cur.pairNew = cleanDiffPath(next.slice(4));
        i += 2;
        continue;
      }
      if (next.startsWith('+++ ')) {
        cur = { pairOld: cleanDiffPath(line.slice(4)), pairNew: cleanDiffPath(next.slice(4)), renameOld: null, renameNew: null, diffOld: null, diffNew: null, create: false, del: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        if (cur.renameOld === null) cur.renameOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (cur.renameNew === null) cur.renameNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const maxTier = strict ? 0 : 2;
    const oldRaw = sec.pairOld ?? sec.renameOld ?? sec.diffOld;
    const newRaw = sec.pairNew ?? sec.renameNew ?? sec.diffNew;
    const oldPath = oldRaw === '/dev/null' ? null : oldRaw;
    const newPath = newRaw === '/dev/null' ? null : newRaw;
    if (oldPath === null && newPath === null) return;
    if (oldPath === null || sec.create) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const ls: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') ls.push(b.text);
      let noBreak = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        for (let j = h.body.length - 1; j >= 0; j--) {
          if (h.body[j]!.kind === 'new') {
            noBreak = h.body[j + 1] !== undefined && h.body[j + 1]!.kind === 'bslash';
            break outer;
          }
        }
      }
      tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (newPath === null || sec.del) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
    let state = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const o: string[] = [];
      const nn: NLine[] = [];
      for (const b of h.body) {
        if (b.kind === 'ctx') {
          o.push(b.text);
          nn.push({ ctx: o.length - 1 });
        } else if (b.kind === 'old') o.push(b.text);
        else if (b.kind === 'new') nn.push({ text: b.text });
      }
      if (o.length === 0) {
        const pos = Math.min(Math.max(h.a + d, 0), state.lines.length);
        const ins = nn.map((e) => ('ctx' in e ? state.lines[0]! : e.text));
        const atEnd = pos === state.lines.length;
        const lines = [...state.lines.slice(0, pos), ...ins, ...state.lines.slice(pos)];
        state = { lines, br: state.br, finalBreak: atEnd ? !h.noFinalBreak : state.finalBreak };
        d += nn.length;
        continue;
      }
      const found = findAtTier(state.lines, o, maxTier);
      if (found === null) throw new Fail('no-match', op);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bd = Math.abs(best - target);
      for (const oc of found.occ) {
        const dd = Math.abs(oc - target);
        if (dd < bd) {
          best = oc;
          bd = dd;
        }
      }
      const atEnd = best + o.length === state.lines.length;
      state = applyAt(state, best, o, nn, found.tier, atEnd ? !h.noFinalBreak : state.finalBreak);
      d += nn.length - o.length;
    }
    if (op === np) {
      tree.now.set(op, joinFile(state));
    } else {
      tree.now.set(op, null);
      tree.now.set(np, joinFile(state));
      tree.moves.push([op, np]);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const st = splitFile(t);
    const found = findAtTier(st.lines, oldLines, strict ? 0 : 2);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const nn: NLine[] = newLines.map((x) => ({ text: x }));
    tree.now.set(path, joinFile(applyAt(st, at, oldLines, nn, found.tier, st.finalBreak)));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  endAnchored: boolean;
  body: UBodyLine[];
}
type VSection =
  | { kind: 'add'; path: string; content: string[]; line: number }
  | { kind: 'delete'; path: string; line: number }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[]; line: number };

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const maxTier = strict ? 0 : 2;
    if (sec.kind === 'add') {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.content.length === 0 ? '' : sec.content.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = sec.path;
    if (!safe(op)) throw new Fail('unsafe', op);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    let np: string | null = null;
    if (sec.moveTo !== null) {
      np = sec.moveTo;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
    }
    let state = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const found = findAtTier(state.lines, [ch.anchor], maxTier, cursor);
        if (found === null) throw new Fail('no-match', op);
        cursor = found.occ[0]! + 1;
      }
      const o: string[] = [];
      const nn: NLine[] = [];
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          o.push(b.text);
          nn.push({ ctx: o.length - 1 });
        } else if (b.kind === 'old') o.push(b.text);
        else if (b.kind === 'new') nn.push({ text: b.text });
      }
      if (o.length === 0) {
        const pos = ch.endAnchored ? state.lines.length : cursor;
        const ins = nn.map((e) => ('ctx' in e ? state.lines[0]! : e.text));
        const lines = [...state.lines.slice(0, pos), ...ins, ...state.lines.slice(pos)];
        state = { lines, br: state.br, finalBreak: state.finalBreak };
        cursor = pos + ins.length;
        continue;
      }
      const found = findAtTier(state.lines, o, maxTier, cursor);
      if (found === null) throw new Fail('no-match', op);
      let at: number | null = null;
      if (ch.endAnchored) {
        for (const oc of found.occ) {
          if (oc + o.length === state.lines.length) {
            at = oc;
            break;
          }
        }
        if (at === null) throw new Fail('no-match', op);
      } else {
        at = found.occ[0]!;
      }
      state = applyAt(state, at, o, nn, found.tier, state.finalBreak);
      cursor = at + nn.length;
    }
    if (np === null) {
      tree.now.set(op, joinFile(state));
    } else {
      tree.now.set(op, null);
      tree.now.set(np, joinFile(state));
      tree.moves.push([op, np]);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i + 1;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith(V_ADD)) {
      kind = 'add';
      path = line.slice(V_ADD.length).trim();
    } else if (line.startsWith(V_DEL)) {
      kind = 'delete';
      path = line.slice(V_DEL.length).trim();
    } else {
      kind = 'update';
      path = line.slice(V_UPD.length).trim();
    }
    i++;
    const raw: string[] = [];
    const rawNums: number[] = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push(lines[i]!);
      rawNums.push(i + 1);
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) {
      raw.pop();
      rawNums.pop();
    }
    if (kind === 'add') {
      const content: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '') content.push('');
        else if (l.startsWith('+')) content.push(l.slice(1));
        else throw new Exit2(`error: parse ${rawNums[k]!}`);
      }
      sections.push({ kind: 'add', path, content, line: startLine });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${rawNums[0]!}`);
      sections.push({ kind: 'delete', path, line: startLine });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith(V_MOVE)) {
        moveTo = raw[0]!.slice(V_MOVE.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          closeChunk();
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), endAnchored: false, body: [] };
        } else if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${rawNums[k]!}`);
          cur.endAnchored = true;
          closeChunk();
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${rawNums[k]!}`);
            cur = { anchor: null, endAnchored: false, body: [] };
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) cur.body.push({ kind: 'old', text: l.slice(1) });
          else cur.body.push({ kind: 'new', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${rawNums[k]!}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      sections.push({ kind: 'update', path, moveTo, chunks, line: startLine });
    }
  }
  return sections.map((s) => v4aEdit(s, strict));
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: invocation, output, order and atomicity.
// ---------------------------------------------------------------------------

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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteOrd = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (tree.original(from) === null) continue;
    let dest = to;
    const seen = new Set<string>([from]);
    let hop = tree.moves.find((m) => m[0] === dest);
    while (hop !== undefined && !seen.has(hop[1])) {
      seen.add(hop[1]);
      dest = hop[1];
      hop = tree.moves.find((m) => m[0] === dest);
    }
    if (tree.original(dest) !== null) continue;
    if (tree.get(from) !== null) continue;
    if (tree.get(dest) === null) continue;
    rows.push({ key: dest, line: `R ${from} -> ${dest}` });
    suppressed.add(from);
    suppressed.add(dest);
  }
  for (const p of [...tree.now.keys()].sort(byteOrd)) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrd(a.key, b.key));
  const outRows = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrd)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
