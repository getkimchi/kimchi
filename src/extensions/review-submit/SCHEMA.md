# Review submit-tool schemas

The finding and summary schemas below are the current v1 producer contract. The reply context and ingest schemas are **provisional until the consumer-side reply implementation lands**. The submit tool intentionally does not inspect comment bodies or bot handles: the producer computes `is_ours` and `mentions_bot` before writing the context.

## Directory selection

`--review` is the only switch that enables review mode and its three submit tools. The other review flags parse without enabling that mode and have no side effects without it. `--review-writer` selects the writer (default `final`); `--review-writer-limit` sets the non-final finding limit to a decimal integer from 1 to 1000 (default 50; no sign, decimal point, exponent, or whitespace). Invalid values return structured `invalid_writer_limit` without writing output, and `final` always remains 50.

`--review-context-dir` and `--review-output-dir` select the directories read and written by the tools. Absolute values are used as-is and relative values resolve from the session's project directory (`ctx.cwd`). Without these flags the directories are `.kimchi/review-context` and `.kimchi/review-output` under the current project. There is no home-directory fallback. The platform supplies `--review --review-writer final --review-context-dir /home/sandbox/review-context --review-output-dir /home/sandbox/review-output` on every fresh and resumed invocation.

The examples below use `<review-context>` and `<review-output>` for the selected directories. With a default path, every component from the project directory through the selected directory is checked and created one level at a time; a symlink or non-directory component is never followed. With a flag-selected path, existing ancestors may be symlinks but the selected leaf and every newly created component must be real directories. Context paths are validated without creating anything: unavailable context leaves anchors unchecked and rejects replies as missing context. Output containment, atomic replacement, and per-writer locking apply in every case. `<review-output>/${writer}.lock.sqlite` is the lock database, kept at the root of `<review-output>`, outside `findings/`, `summary/`, and `replies/`.

Preventing a concurrent process from swapping an already validated component for a symlink before a later write is a non-goal. Such a process already has the same filesystem access as the agent, and Node has no openat-style no-follow traversal.

The `--review*` switches are intentionally omitted from `kimchi --help`; they remain valid for the platform's headless integration.

## `review-finding/v1`

Accepted findings append one compact JSON object per line to `<review-output>/findings/<writer>.jsonl`. A writer holds at most 50 findings, subject to the configured non-final writer limit, and all files remain within the shared 1 MiB limit.

Every candidate and final record contains:

- `schema_version`: exactly `"review-finding/v1"`.
- `id`: `<writer>-<seq>`.
- `writer`: the configured writer ID.
- `seq`: contiguous positive sequence, starting at 1.
- `created_at`: RFC 3339 UTC timestamp.
- `path`: repository-relative path, maximum 4 KiB in UTF-8, no NUL.
- `line`: new-side line number, a positive signed 32-bit integer validated against the applicable anchor map.
- `title`: required, 1..80 Unicode code points after trimming. A single plain line saying what is wrong; control characters and line separators are rejected.
- `description`: required, 1..250 Unicode code points after trimming. The impact: who is affected and how, for quick triage.
- `explanation`: required, 1..2000 Unicode code points after trimming. Reasoning and evidence, including relevant code paths. State what was run (commands, probes, tests) and the observed results, or state that the finding comes from reading code.
- `suggestion`: required, 1..500 Unicode code points after trimming. The concrete fix.
- `priority`: required, one of `P0`, `P1`, `P2`, `P3`, `P4`.
- `type`: required, one of `bug`, `security`, `reliability`, `performance`, `convention`, `test-gap`, `docs`.
- `derived_from`: optional array of at most 50 prior or merged finding IDs; each ID is non-empty and at most 256 UTF-8 bytes.

Priority means:

| Value | Meaning | Short example |
| --- | --- | --- |
| `P0` | An outage, security hole, or data loss that can happen in production. | A request can delete another tenant's data. |
| `P1` | A main feature is broken, or a likely bug is on the main path. | The normal export command rejects valid input. |
| `P2` | A minor feature is broken, or an edge-case bug exists. | Only an empty optional filename is mishandled. |
| `P3` | Affects a few users, or is a real maintainability risk. | A rare locale fails, or duplicated validation invites drift. |
| `P4` | Negligible impact; conventions, style, or docs. | A guide names a retired option. |

Text lengths are measured in Unicode code points after trimming; UTF-8 bytes are not substituted. The stored fields are trimmed. Over-limit input is rejected with the field, maximum, and actual length so the caller can rewrite it; the tools never truncate silently. Unknown fields, including the removed `severity` and finding-level `evidence`, are rejected. Stored submission reads and final serialization validate schema, matching writer/sequence/ID, timestamps, and all semantic fields.

Interim candidate checkpoints preserve submitted priorities. Only final wrap-up publication, including reused or recovered fallback, applies caps in code: `convention` and `docs` become `P4`, and `test-gap` becomes at most `P3`. No `priority_capped_from` metadata is emitted. Final ranking and coverage use capped priorities and remapped contiguous final IDs. Reconciliation may change only `title` and `priority`; all other semantic fields must exactly match one best-supported source candidate.

## `review-summary/v1`

`<review-output>/summary/final.json` remains the review summary. Its optional structured `coverage` includes lens completion counts, candidate and final finding counts, `provenance_truncated_count`, and `findings_by_priority`, an object with nonnegative `P0` through `P4` counts whose sum equals `final_finding_count`. The panel summary body includes the same capped-priority counts.

## `review-comments/v1`

`<review-context>/comments.json` is one JSON object, never a raw array or an unversioned document:

- `schema_version`: required, exactly `"review-comments/v1"`.
- `threads`: required array. Every entry is an object with:
  - `thread_id`: required, non-empty string (maximum 256 UTF-8 bytes, no NUL).
  - `is_ours`: required boolean, computed by the producer.
  - `mentions_bot`: required boolean, computed by the producer.

Optional context fields used for review/verification (for example anchors, resolved state, verdict history, and `comments` entries with `author`, `role`, and `body`) may be present. They are context for the agent, not aliases for the required scope fields and not interpreted by `submit_reply`.

The whole document and every thread are validated before use. Missing, null, incorrectly typed, unversioned, or differently versioned input returns `invalid_context` and writes nothing. Replies are allowed only when `is_ours || mentions_bot`; `resolve` and `reopen` additionally require `is_ours`.

## `review-reply/v1`

Accepted replies append one compact JSON object per line to `<review-output>/replies/<writer>.jsonl`. Nothing is posted.

Fields:

- `schema_version`: exactly `"review-reply/v1"`.
- `id`: `<writer>-<seq>`.
- `writer`: the configured writer from `--review-writer` (default `final`).
- `seq`: contiguous positive sequence, starting at 1.
- `created_at`: RFC 3339 UTC timestamp.
- `thread_id`: the validated existing thread ID.
- `body`: non-empty string, maximum 64 KiB in UTF-8, no NUL.
- `action`: `resolve`, `reopen`, or `none`.
- `verdict`: optional for mention-only threads; required for our threads. One of `fixed`, `not_fixed`, `partially_fixed`, `no_longer_applicable`, `regressed`, or `unverified`.
- `evidence_kind`: optional for mention-only threads; required for our threads. One of `code_reference`, `existing_test`, `new_test`, or `none`.
- `evidence`: optional for mention-only threads; required (possibly empty) for our threads, maximum 16 KiB in UTF-8, no NUL.

A writer file holds at most 30 replies. Counting, sequence assignment, and append happen under the writer lock and survive process restarts.

The local tests include accepted in-scope replies, missing/invalid context, unknown and out-of-scope threads, forbidden actions, missing verification fields, exact artifact content, and a fresh process enforcing the 30-reply cap. Reply cases will join the shared finding/summary fixture when the consumer side supplies `comments.json` and expected reply artifacts.
