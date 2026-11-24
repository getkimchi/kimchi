# Non-interactive runs

`kimchi --print` and `kimchi --print --mode json` run one prompt and exit. This page covers how the prompt and boolean flags are read, and the two guards that make sure a run that produced nothing does not look like a success.

The guards apply to every non-interactive run. pi also runs in print mode when stdin or stdout is not a terminal, so `kimchi "question" > answer.txt` and `echo question | kimchi` are guarded too.

## Prompt sources

The prompt can come from any of these:

- Positional text: `kimchi --print "explain this repo"`.
- An `@file` argument: `kimchi --print @prompt.md`.
- Piped stdin: `echo "explain this repo" | kimchi --print`.

An empty positional prompt (`kimchi --print ""`) or an empty `@file` is not a prompt, and the run exits `2`.

A slash command from any of these sources, such as `echo /language | kimchi --print`, counts as a prompt. It exits `0` when the agent does not run.

## Boolean flag syntax

Kimchi boolean flags never take a separate value. `--auto`, `--yolo`, `--plan` and the other booleans are on/off switches, so a following token is always a different argument, such as the prompt.

Before pi parses argv, `normalizeBooleanFlagArgs` (`src/cli-args.ts`) rewrites a bare Kimchi-only boolean flag to `--flag=true`. Without this, pi treats the next non-flag token as the flag's value and the positional prompt is lost. Normalization is skipped after `--`.

Both explicit forms are valid. `--flag=true` turns the flag on, and `--flag=false` keeps it off. pi turns any value of a boolean extension flag into `true`, so the normalizer drops `--flag=false` for Kimchi-only booleans before pi sees it. This matters most for `--dangerously-skip-permissions=false`, which would otherwise leave permissions in a mixed state. `--enable-experimental-features` works only in its bare form.

```sh
kimchi --print --auto=true "do the work"
kimchi --print --auto=false "do the work"
kimchi --print --auto "do the work"       # same as --auto=true
kimchi --print "do the work" --auto       # prompt before flags also works
```

## Catalog governance

`CLI_OPTIONS` in `src/cli-args.ts` is the single catalog of Kimchi flags, with their names and types. Every flag an extension registers with `registerFlag` must have a `CLI_OPTIONS` entry with the same name and type. A flag that only extensions know about can be missing from the catalog, and then normalization cannot protect its prompt.

Flags that should parse but not appear in `--help` set `hidden: true` in the catalog.

`src/cli-args.test.ts` enforces this. The "extension flag registration parity" test fails if any `registerFlag` call lacks a matching catalog entry, or its type differs. The flag name must be a string literal or a constant listed in `FLAG_NAME_CONSTANTS` in that test. When you add a flag, add it to `CLI_OPTIONS` in the same change.

## What counts as an answer

In text mode, stdout shows the text of the last message, as pi decides it. These do not count as an answer:

- an empty final message,
- a whitespace-only final message,
- a thinking-only final message,
- a final message that only calls tools,
- a final message that is not from the assistant,
- a prompt that an extension or hook handled, so the agent never ran. For example, a `UserPromptSubmit` hook that blocks the prompt.

A final message that ended with a model error, an abort, or truncation is not a guard failure. In text mode, pi exits `1` for it. In JSON mode, the exit code stays `0` and the outcome is visible in the event stream.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | A real answer, or a normal command such as `--list-models` |
| `1` | Model error, abort, or truncation (text mode only) |
| `2` | No prompt reached the agent |
| `3` | The run finished without a final answer |
| `74` | Provider infrastructure failure |

The guards only replace an unset or zero exit code. In text mode, code `1` is never changed. Code `74` is never changed in either mode. In JSON mode, a model error, abort, or truncation exits `0`, as before, and is not a guard failure.

## Diagnostics

Each guard writes one diagnostic to stderr. Stdout is not changed.

- Exit `2`: the first line starts with `KIMCHI_NO_PROMPT:`.
- Exit `3`: the first line starts with `KIMCHI_NO_RESULT:`. The next lines name the last event, for example a blocked tool and its reason. Model text is never printed.

For exit `3`, the diagnostic also gives the session file path and tells you to rerun with `--mode json` to see every step. With `--no-session` no file is saved, and the diagnostic says that no session was saved.

## JSON mode

`--mode json` keeps its newline-delimited event stream on stdout, with no added events or text. Only the guard outcomes change its exit code: it now uses exit codes `2` and `3`. Model error, abort, and truncation still exit `0` in JSON mode, and the event stream shows them.

This is a change for existing automation: a JSON run with no prompt or no final answer used to exit `0`. It now exits `2` or `3`. Scripts that treated `0` as success for these runs must handle the new codes.

## Troubleshooting

- Exit `2`: a flag such as `--auto` may have taken the prompt as its value, or the prompt was empty. Put the prompt before the flags, or write the flag as `--auto=true`.
- Exit `3` with a blocked tool: a permission rule, the permission mode, a hook or a disabled resource blocked a tool, and the model gave no answer after that. Allow the tool, then rerun.
- Exit `3` because an extension handled the prompt: a hook or an extension stopped the prompt before the agent ran. Check your hooks, or rerun with `--mode json`.
- Exit `3` after an empty answer: open the session file, or rerun with `--mode json`, to see the steps.

Ferment V2 runs manage their own exit code, so the no-answer guard (exit `3`) does not apply to them. A run is exempt only when Ferment V2 writes a live record during that run. A live record left by an earlier prompt does not exempt a plain follow-up prompt, whether that prompt runs in the same process or on a resumed session. A Ferment V2 clear record ends the exemption.

TUI and ACP sessions are not affected by these guards.
