[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/boykers-agent/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/boykers-agent/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122): one patch tool for every AI edit format.


## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file, relative to the working directory. When absent or `-`,
  the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`;
  `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file changed.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` with one line per changed path plus `ok: <n> files`; `1` with one
`error: <code> <path>` line per failed edit plus `failed: <k> of <n> edits` (and no
file written); `2` with a single usage / no-patch / format / parse error line.

## Matching

An edit's old lines are found at the first of three tiers at which they occur:
exact (tier 0), ignoring trailing spaces and tabs (tier 1), or ignoring leading
and trailing spaces and tabs (tier 2, with new lines re-indented to the file's
own indentation). A unified hunk takes the occurrence nearest its (possibly
wrong) line number; a SEARCH/REPLACE block requires exactly one occurrence;
a V4A chunk works from a cursor moved by its anchor.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner (unchanged from the starter).
- `check.ts` — runs `main.ts` on the kit's 100 public practice checks:
  `node check.ts <practice.json>`; this entry scores **1000** (100 of 100).
- `SPEC.md` — the full specification.

## License

MIT. See `LICENSE`.
