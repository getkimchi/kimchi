# Resume by name

Kimchi supports resuming sessions by their user-assigned name via `-r`/`--resume`.

## How it works

Session names are informal labels stored inside JSONL session files. The
CLI argument normalizer (`cli-args.ts`) handles selector-shaped values
(full UUIDs and path-likes) synchronously, but name resolution requires
reading session metadata from disk — so it runs as a separate async pass
in `src/resume-by-name.ts`.

### Accepted forms

| Form               | Example                   |
| ------------------ | ------------------------- |
| `-r <name>`         | `-r "parser spike"`       |
| `--resume <name>`   | `--resume "parser spike"` |
| `--resume=<name>`   | `--resume=parser-spike`   |
| `-r<name>`          | `-rparser-spike`          |

### Resolution rules

1. Values that look like selectors (full UUIDs, paths starting with `/`,
   `./`, `../`, `~/`) are left for the existing `normalizeResumeIdArgs`
   path — no disk scan is attempted.
2. Matching is **exact but case-insensitive** — `"Parser Spike"` matches
   `-r "parser spike"`.
3. When multiple sessions share a name, sessions in the **current project
   directory** are preferred over those in other directories.
4. Among ties, the **most recently modified** session wins.
5. A matched session's args are rewritten to `--session <path>`, which
   upstream already handles.

### Fail-open behavior

If no session matches the given name, or the sessions directory cannot be
read, the original args are returned unchanged — falling through to
upstream's resume picker or error handling.

## Key functions

- `resolveResumeNameArgs(args, agentDir, cwd)` — entry point; `cwd` is
  required (no `process.cwd()` default — callers must pass `ctx.cwd`).
  Returns a new array with matched names rewritten (or the original
  reference if nothing changed).
- `pickSessionByName(sessions, name, cwd)` — pure matching logic,
  exported for direct use and testing.
