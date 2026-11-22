# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/faj17/hidden-spec-cli-01-run-20261122c/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/faj17/hidden-spec-cli-01-run-20261122c/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

[make.fun bounty: Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a single command-line tool that applies AI-written edits to a tree of
text files. Models write edits in four formats — a unified diff (often with
wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
text-editor tool calls as JSON — and `mend` reads all four to one written
specification (`SPEC.md`, version 1). It finds the lines an edit names even
when the model drifted their whitespace or indentation, and it changes every
file or none: a failed edit reports and nothing is written.

## How to run it

Node 22, standard library only — nothing is installed.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the tree root).
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects the format.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: 0 — applied, with one `A`/`D`/`M`/`R` line per changed file and
`ok: <n> files`; 1 — one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`, nothing written; 2 — usage, unreadable patch,
unknown format or parse error, exactly one `error: ...` line.

Matching works at three tiers: exact, trailing whitespace ignored, then
leading and trailing whitespace ignored with tier-2 re-indentation of the new
lines. Unified hunks take the occurrence nearest the hunk's line number;
SEARCH/REPLACE blocks fail `ambiguous` when the old lines occur more than
once; V4A chunks walk a cursor through the file with anchors and an
end-of-file anchor. Moves print `R <old> -> <new>`.

## Files

- `main.ts` — the `mend` CLI.
- `runner.ts` — the kit's trial runner (used when `MAKEFUN_ENV_URL` is set).
- `check.ts` — the kit's practice checker.
- `SPEC.md` — the specification (version 1).
- `LICENSE` — MIT.

## Practice score

`node check.ts <kit>/program/generator/practice.json` — **100 of 100 passed:
practice score 1000**.
