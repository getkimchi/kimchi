# Non-interactive runs

`kimchi --print` and `kimchi --print --mode json` run one prompt and exit. Two guards make sure a run that produced nothing does not look like a success.

## Prompt sources

The prompt can come from any of these:

- Positional text: `kimchi --print "explain this repo"`.
- An `@file` argument: `kimchi --print @prompt.md`.
- Piped stdin: `echo "explain this repo" | kimchi --print`.

## What counts as an answer

In text mode, stdout shows the text of the last message, as pi decides it. These do not count as an answer:

- an empty final message,
- a whitespace-only final message,
- a thinking-only final message,
- a final message that only calls tools,
- a final message that is not from the assistant.

A final message that ended with a model error, an abort, or truncation is not a guard failure. It keeps its own exit code.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | A real answer, or a normal command such as `--list-models` |
| `1` | Model error, abort, or truncation |
| `2` | No prompt reached the agent |
| `3` | The run finished without a final answer |
| `74` | Provider infrastructure failure |

The guards only replace an unset or zero exit code. Codes `1` and `74` are never changed.

## Diagnostics

Each guard writes one diagnostic to stderr. Stdout is not changed.

- Exit `2`: the first line starts with `KIMCHI_NO_PROMPT:`.
- Exit `3`: the first line starts with `KIMCHI_NO_RESULT:`. The next lines name the last event, for example a denied tool and its reason. Model text is never printed.

For exit `3`, the diagnostic also gives the session file path and tells you to rerun with `--mode json` to see every step. With `--no-session` no file is saved, and the diagnostic says that no session was saved.

## JSON mode

`--mode json` keeps its newline-delimited event stream on stdout, with no added events or text. It now uses the same exit codes `2` and `3`.

This is a change for existing automation: a JSON run with no prompt or no final answer used to exit `0`. It now exits `2` or `3`. Scripts that treated `0` as success for these runs must handle the new codes.

## Troubleshooting

- Exit `2`: a flag such as `--auto` may have taken the prompt as its value. Put the prompt before the flags, or write the flag as `--auto=true`.
- Exit `3` with a denied tool: the permission mode blocked a tool and the model gave no answer after that. Change the permission mode or allow the tool, then rerun.
- Exit `3` after an empty answer: open the session file, or rerun with `--mode json`, to see the steps.

Ferment V2 sessions manage their own exit code, so the no-answer guard (exit `3`) does not apply to them.

TUI and ACP sessions are not affected by these guards.
