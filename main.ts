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

/** The blank prefix of a line (spaces and tabs only). */
function indentOf(s: string): string {
  const found = /^[ \t]*/.exec(s);
  return found === null ? '' : found[0];
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

/** Throw `unsafe` unless `p` is a safe path (section 3). */
function mustBeSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** The file at `p` as the tree now holds it, or throw `missing`. */
function mustExist(tree: Tree, p: string): string {
  const text = tree.get(p);
  if (text === null) throw new Fail('missing', p);
  return text;
}

/** Throw `exists` unless nothing is at `p` yet. */
function mustBeNew(tree: Tree, p: string): void {
  if (tree.get(p) !== null) throw new Fail('exists', p);
}

/** Record a move of `from` to `to` holding `text`, for the `R` output line. */
function recordMove(tree: Tree, from: string, to: string, text: string): void {
  tree.now.set(from, null);
  tree.now.set(to, text);
  tree.moves.push([from, to]);
}

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
//
// An edit names old lines O and new lines N. O is looked for in the file at
// the first tier where it shows up at all: exact lines, then lines compared
// without trailing blanks, then lines compared without blanks at either end.
// The tier decides how N is written back: at the loosest tier the new lines
// take the file's own indentation in place of O's. Every finder below works
// on the file's current lines, so later edits see earlier ones.

/** O's line as tier `tier` sees it: exact, trailing blanks off, both ends off. */
function tierText(line: string, tier: number): string {
  if (tier === 0) return line;
  const trimmed = line.replace(/[ \t]+$/, '');
  if (tier === 1) return trimmed;
  return trimmed.replace(/^[ \t]+/, '');
}

/** 0-based starts where `want` sits in `lines` at `tier`, from `from` on. */
function scanFor(lines: string[], want: string[], tier: number, from = 0): number[] {
  const hits: number[] = [];
  if (want.length === 0) return hits;
  const lastStart = lines.length - want.length;
  for (let start = from; start <= lastStart; start++) {
    let match = true;
    for (let k = 0; k < want.length; k++) {
      if (tierText(lines[start + k]!, tier) !== tierText(want[k]!, tier)) {
        match = false;
        break;
      }
    }
    if (match) hits.push(start);
  }
  return hits;
}

/** First tier (0..maxTier) where `want` occurs at or after `from`, and where. */
function locate(lines: string[], want: string[], maxTier: number, from = 0): { tier: number; at: number[] } | null {
  for (let tier = 0; tier <= maxTier; tier++) {
    const at = scanFor(lines, want, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of N: a context line kept from the file, or a fresh line's text. */
type Fresh = { keep: number } | { text: string };

/** The lines N writes when it replaces O at `pos`: kept lines come from the
 * file itself; at tier 2 every other line is re-indented from O's first
 * line's blank prefix to the file's. */
function renderNew(doc: FileState, pos: number, old: string[], fresh: Fresh[], tier: number): string[] {
  const filePad = old.length > 0 ? indentOf(doc.lines[pos] ?? '') : '';
  const patchPad = old.length > 0 ? indentOf(old[0]!) : '';
  const out: string[] = [];
  for (const item of fresh) {
    if ('keep' in item) {
      out.push(doc.lines[pos + item.keep]!);
      continue;
    }
    let text = item.text;
    if (tier === 2 && text !== '' && !/^[ \t]+$/.test(text) && text.startsWith(patchPad)) {
      text = filePad + text.slice(patchPad.length);
    }
    out.push(text);
  }
  return out;
}

/** `doc` with O at `pos` replaced by N; `finalBreak` is the result's last break. */
function spliceAt(doc: FileState, pos: number, old: string[], fresh: Fresh[], tier: number, finalBreak: boolean): FileState {
  const written = renderNew(doc, pos, old, fresh, tier);
  return { lines: [...doc.lines.slice(0, pos), ...written, ...doc.lines.slice(pos + old.length)], br: doc.br, finalBreak };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits (from the kit's starter).
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonOp(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needText = (tree: Tree): string => {
    mustBeSafe(p);
    return mustExist(tree, p);
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      mustBeSafe(p);
      mustBeNew(tree, p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needText(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = needText(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (lineNo < 0 || lineNo > lines.length) throw new Fail('no-match', p);
      lines.splice(lineNo, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonOps(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const ops: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonOp(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      ops.push(e);
    }
    return ops;
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (blank(l)) continue;
    let e: Edit | null = null;
    try {
      e = jsonOp(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    ops.push(e);
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------
//
// A diff is read section by section. Each section names its old and new
// paths, says whether it creates, deletes or moves, and carries hunks; each
// hunk is one old-lines/new-lines pair applied in order, with the running
// drift keeping the hunk headers honest when earlier hunks changed the
// length. A section is a single edit: any hunk that cannot apply fails the
// whole section and the section writes nothing.

/** One body line of a hunk: kept, removed, added, or a backslash marker. */
interface HunkLine {
  kind: 'keep' | 'drop' | 'add' | 'mark';
  text: string;
}
interface Hunk {
  start: number;
  lines: HunkLine[];
  /** a `\` line follows the hunk's last kept or `+` line. */
  dropsBreak: boolean;
}
interface DiffSection {
  headOld: string | null;
  headNew: string | null;
  fromName: string | null;
  toName: string | null;
  gitOld: string | null;
  gitNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  parts: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, outer spaces off, a
 * leading `a/` or `b/` off. */
function diffPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_DIFF_RE = /^diff --git a\/(.+?) b\/(.+)$/;

function parseDiff(lines: string[], strict: boolean): Edit[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let heading = false;
  const total = lines.length;
  let i = 0;
  while (i < total) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = GIT_DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      current = { headOld: null, headNew: null, fromName: null, toName: null, gitOld: m[1]!, gitNew: m[2]!, isCreate: false, isDelete: false, parts: [] };
      sections.push(current);
      heading = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (current === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const start = parseInt(m[1]!, 10);
      i++;
      const body: HunkLine[] = [];
      while (i < total) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') body.push({ kind: 'keep', text: '' });
        else if (bl.startsWith(' ')) body.push({ kind: 'keep', text: bl.slice(1) });
        else if (bl.startsWith('-')) body.push({ kind: 'drop', text: bl.slice(1) });
        else if (bl.startsWith('+')) body.push({ kind: 'add', text: bl.slice(1) });
        else if (bl.startsWith('\\')) body.push({ kind: 'mark', text: bl.slice(1) });
        else break;
        i++;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'keep' && body[body.length - 1]!.text === '') body.pop();
      let dropsBreak = false;
      for (let j = body.length - 1; j >= 0; j--) {
        if (body[j]!.kind === 'keep' || body[j]!.kind === 'add') {
          dropsBreak = body[j + 1] !== undefined && body[j + 1]!.kind === 'mark';
          break;
        }
      }
      current.parts.push({ start, lines: body, dropsBreak });
      heading = false;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (heading && current !== null) {
        if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        current.headOld = diffPath(line.slice(4));
        current.headNew = diffPath(next.slice(4));
        i += 2;
        continue;
      }
      if (next.startsWith('+++ ')) {
        current = { headOld: diffPath(line.slice(4)), headNew: diffPath(next.slice(4)), fromName: null, toName: null, gitOld: null, gitNew: null, isCreate: false, isDelete: false, parts: [] };
        sections.push(current);
        heading = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (current !== null && heading) {
      if (line.startsWith('rename from ')) {
        if (current.fromName === null) current.fromName = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (current.toName === null) current.toName = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) current.isCreate = true;
      else if (line.startsWith('deleted file mode')) current.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => applyDiff(s, strict));
}

function applyDiff(sec: DiffSection, strict: boolean): Edit {
  return (tree) => {
    const maxTier = strict ? 0 : 2;
    const oldRaw = sec.headOld ?? sec.fromName ?? sec.gitOld;
    const newRaw = sec.headNew ?? sec.toName ?? sec.gitNew;
    const oldPath = oldRaw === '/dev/null' ? null : oldRaw;
    const newPath = newRaw === '/dev/null' ? null : newRaw;
    if (oldPath === null && newPath === null) return;
    if (oldPath === null || sec.isCreate) {
      const p = newPath!;
      mustBeSafe(p);
      mustBeNew(tree, p);
      const made: string[] = [];
      for (const h of sec.parts) for (const b of h.lines) if (b.kind === 'add') made.push(b.text);
      let dropsBreak = false;
      outer: for (let hi = sec.parts.length - 1; hi >= 0; hi--) {
        const h = sec.parts[hi]!;
        for (let j = h.lines.length - 1; j >= 0; j--) {
          if (h.lines[j]!.kind === 'add') {
            dropsBreak = h.lines[j + 1] !== undefined && h.lines[j + 1]!.kind === 'mark';
            break outer;
          }
        }
      }
      tree.now.set(p, made.length === 0 ? '' : made.join('\n') + (dropsBreak ? '' : '\n'));
      return;
    }
    if (newPath === null || sec.isDelete) {
      const p = oldPath!;
      mustBeSafe(p);
      mustExist(tree, p);
      tree.now.set(p, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    mustBeSafe(op);
    mustBeSafe(np);
    const before = mustExist(tree, op);
    if (op !== np) mustBeNew(tree, np);
    let doc = splitFile(before);
    let drift = 0;
    for (const h of sec.parts) {
      const old: string[] = [];
      const fresh: Fresh[] = [];
      for (const b of h.lines) {
        if (b.kind === 'keep') {
          old.push(b.text);
          fresh.push({ keep: old.length - 1 });
        } else if (b.kind === 'drop') old.push(b.text);
        else if (b.kind === 'add') fresh.push({ text: b.text });
      }
      if (old.length === 0) {
        const pos = Math.min(Math.max(h.start + drift, 0), doc.lines.length);
        const ins = fresh.map((e) => ('keep' in e ? doc.lines[0]! : e.text));
        const atEnd = pos === doc.lines.length;
        const lines = [...doc.lines.slice(0, pos), ...ins, ...doc.lines.slice(pos)];
        doc = { lines, br: doc.br, finalBreak: atEnd ? !h.dropsBreak : doc.finalBreak };
        drift += fresh.length;
        continue;
      }
      const found = locate(doc.lines, old, maxTier);
      if (found === null) throw new Fail('no-match', op);
      const target = h.start - 1 + drift;
      let best = found.at[0]!;
      let gap = Math.abs(best - target);
      for (const spot of found.at) {
        const dd = Math.abs(spot - target);
        if (dd < gap) {
          best = spot;
          gap = dd;
        }
      }
      const atEnd = best + old.length === doc.lines.length;
      doc = spliceAt(doc, best, old, fresh, found.tier, atEnd ? !h.dropsBreak : doc.finalBreak);
      drift += fresh.length - old.length;
    }
    const result = joinFile(doc);
    if (op === np) {
      tree.now.set(op, result);
    } else {
      recordMove(tree, op, np, result);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------
//
// A block names its file on the nearest usable line above it and carries one
// old-lines/new-lines pair. An empty old side creates the file; otherwise
// the old lines must occur exactly once at their tier, or the block fails
// ambiguous. Blocks apply in order, each seeing the tree the earlier ones
// left.

function applyReplace(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    mustBeSafe(path);
    if (oldLines.length === 0) {
      mustBeNew(tree, path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const current = mustExist(tree, path);
    const doc = splitFile(current);
    const found = locate(doc.lines, oldLines, strict ? 0 : 2);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const fresh: Fresh[] = newLines.map((x) => ({ text: x }));
    tree.now.set(path, joinFile(spliceAt(doc, pos, oldLines, fresh, found.tier, doc.finalBreak)));
  };
}

function parseBlocks(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let afterPrev = 0;
  let lastPath: string | null = null;
  const total = lines.length;
  let i = 0;
  while (i < total) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= afterPrev; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (lastPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = lastPath;
      }
      let eq = -1;
      for (let j = i + 1; j < total; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < total; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(applyReplace(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
      lastPath = path;
      afterPrev = rep + 1;
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
//
// A patch opens with `*** Begin Patch`, closes with `*** End Patch`, and
// holds add, delete and update sections. An update section walks its chunks
// through the file with a cursor: an anchor jumps the cursor past the first
// line that equals it, an end-of-file chunk only takes an occurrence that
// ends at the last line, and an empty old side inserts at the cursor (or at
// the end for an end-of-file chunk). A `*** Move to:` line moves the result.

/** One chunk of an update section: its anchor, end-of-file flag, body lines. */
interface Chunk {
  mark: string | null;
  atEnd: boolean;
  lines: HunkLine[];
}
type PatchSection =
  | { kind: 'add'; path: string; content: string[]; at: number }
  | { kind: 'delete'; path: string; at: number }
  | { kind: 'update'; path: string; dest: string | null; parts: Chunk[]; at: number };

const P_ADD = '*** Add File: ';
const P_DEL = '*** Delete File: ';
const P_UPD = '*** Update File: ';
const P_MOV = '*** Move to: ';

function applyV4a(sec: PatchSection, strict: boolean): Edit {
  return (tree) => {
    const maxTier = strict ? 0 : 2;
    if (sec.kind === 'add') {
      const p = sec.path;
      mustBeSafe(p);
      mustBeNew(tree, p);
      tree.now.set(p, sec.content.length === 0 ? '' : sec.content.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      mustBeSafe(p);
      mustExist(tree, p);
      tree.now.set(p, null);
      return;
    }
    const op = sec.path;
    mustBeSafe(op);
    const before = mustExist(tree, op);
    let np: string | null = null;
    if (sec.dest !== null) {
      np = sec.dest;
      mustBeSafe(np);
      mustBeNew(tree, np);
    }
    let doc = splitFile(before);
    let cursor = 0;
    for (const ch of sec.parts) {
      if (ch.mark !== null) {
        const found = locate(doc.lines, [ch.mark], maxTier, cursor);
        if (found === null) throw new Fail('no-match', op);
        cursor = found.at[0]! + 1;
      }
      const old: string[] = [];
      const fresh: Fresh[] = [];
      for (const b of ch.lines) {
        if (b.kind === 'keep') {
          old.push(b.text);
          fresh.push({ keep: old.length - 1 });
        } else if (b.kind === 'drop') old.push(b.text);
        else if (b.kind === 'add') fresh.push({ text: b.text });
      }
      if (old.length === 0) {
        const pos = ch.atEnd ? doc.lines.length : cursor;
        const ins = fresh.map((e) => ('keep' in e ? doc.lines[0]! : e.text));
        const lines = [...doc.lines.slice(0, pos), ...ins, ...doc.lines.slice(pos)];
        doc = { lines, br: doc.br, finalBreak: doc.finalBreak };
        cursor = pos + ins.length;
        continue;
      }
      const found = locate(doc.lines, old, maxTier, cursor);
      if (found === null) throw new Fail('no-match', op);
      let pos: number | null = null;
      if (ch.atEnd) {
        for (const spot of found.at) {
          if (spot + old.length === doc.lines.length) {
            pos = spot;
            break;
          }
        }
        if (pos === null) throw new Fail('no-match', op);
      } else {
        pos = found.at[0]!;
      }
      doc = spliceAt(doc, pos, old, fresh, found.tier, doc.finalBreak);
      cursor = pos + fresh.length;
    }
    const result = joinFile(doc);
    if (np === null) {
      tree.now.set(op, result);
    } else {
      recordMove(tree, op, np, result);
    }
  };
}

function parsePatch(lines: string[], strict: boolean): Edit[] {
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
  const sections: PatchSection[] = [];
  let i = first + 1;
  const startsSection = (l: string): boolean => l.startsWith(P_ADD) || l.startsWith(P_DEL) || l.startsWith(P_UPD);
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!startsSection(line)) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i + 1;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith(P_ADD)) {
      kind = 'add';
      path = line.slice(P_ADD.length).trim();
    } else if (line.startsWith(P_DEL)) {
      kind = 'delete';
      path = line.slice(P_DEL.length).trim();
    } else {
      kind = 'update';
      path = line.slice(P_UPD.length).trim();
    }
    i++;
    const raw: string[] = [];
    const rawNums: number[] = [];
    while (i < last && !startsSection(lines[i]!)) {
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
      sections.push({ kind: 'add', path, content, at: startLine });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${rawNums[0]!}`);
      sections.push({ kind: 'delete', path, at: startLine });
    } else {
      let dest: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith(P_MOV)) {
        dest = raw[0]!.slice(P_MOV.length).trim();
        k = 1;
      }
      const parts: Chunk[] = [];
      let cur: Chunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          parts.push(cur);
          cur = null;
        }
      };
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          closeChunk();
          cur = { mark: l.slice(2).trim() === '' ? null : l.slice(2).trim(), atEnd: false, lines: [] };
        } else if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${rawNums[k]!}`);
          cur.atEnd = true;
          closeChunk();
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (parts.length > 0) throw new Exit2(`error: parse ${rawNums[k]!}`);
            cur = { mark: null, atEnd: false, lines: [] };
          }
          if (l === '') cur.lines.push({ kind: 'keep', text: '' });
          else if (l.startsWith(' ')) cur.lines.push({ kind: 'keep', text: l.slice(1) });
          else if (l.startsWith('-')) cur.lines.push({ kind: 'drop', text: l.slice(1) });
          else cur.lines.push({ kind: 'add', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${rawNums[k]!}`);
        }
      }
      closeChunk();
      if (parts.length === 0 && dest === null) throw new Exit2(`error: parse ${startLine}`);
      sections.push({ kind: 'update', path, dest, parts, at: startLine });
    }
  }
  return sections.map((s) => applyV4a(s, strict));
}

// ---------------------------------------------------------------------------
// Invocation, output, order and atomicity (sections 1, 2 and 10).
// ---------------------------------------------------------------------------
//
// One run: read the options and the patch, turn the patch into edits, apply
// them to a tree held in memory, and only write the tree out when every edit
// succeeded. A failed edit is rolled back on its own and the rest still run,
// so all failures are reported at once; when any failed, nothing is written.

function run(args: string[]): { code: number; out: string[] } {
  let wanted: string | null = null;
  let dryRun = false;
  let exact = false;
  const positionals: string[] = [];
  let afterDashDash = false;
  for (let n = 0; n < args.length; n++) {
    const a = args[n]!;
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
    } else if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && wanted === null && FORMATS.includes(a.slice(9))) wanted = a.slice(9);
      else if (a === '--check' && !dryRun) dryRun = true;
      else if (a === '--strict' && !exact) exact = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 1) return { code: 2, out: ['error: usage'] };
  const patchPath = positionals.length === 0 || positionals[0] === '-' ? null : positionals[0]!;
  let patchText = '';
  try {
    patchText = readFileSync(patchPath ?? 0, 'utf8');
  } catch {
    if (patchPath !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const inputLines = patchLines(patchText);
  const flavour = wanted === null || wanted === 'auto' ? detect(inputLines) : wanted;
  if (flavour === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (flavour === 'json') edits = jsonOps(patchText, inputLines);
    else if (flavour === 'unified') edits = parseDiff(inputLines, exact);
    else if (flavour === 'search-replace') edits = parseBlocks(inputLines, exact);
    else edits = parsePatch(inputLines, exact);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const failures: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    const lines = failures.map((f) => `error: ${f.code} ${f.path}`);
    lines.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out: lines };
  }
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; line: string }[] = [];
  const hidden = new Set<string>();
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
    hidden.add(from);
    hidden.add(dest);
  }
  const changed = [...tree.now.keys()].sort(byBytes);
  for (const p of changed) {
    if (hidden.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const mark = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ key: p, line: `${mark} ${p}` });
  }
  rows.sort((a, b) => byBytes(a.key, b.key));
  const outRows = rows.map((r) => r.line);
  if (!dryRun) {
    for (const p of changed) {
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
  const word = outRows.length === 1 ? 'file' : 'files';
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${word}`] };
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
