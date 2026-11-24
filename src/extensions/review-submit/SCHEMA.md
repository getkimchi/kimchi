# Review reply schemas (provisional)

These schemas are **provisional until the consumer-side reply context and ingest implementation lands**. The submit tool intentionally does not inspect comment bodies or bot handles: the producer computes `is_ours` and `mentions_bot` before writing the context.

## `review-comments/v1`

`$HOME/review-context/comments.json` is one JSON object, never a raw array or an unversioned document:

- `schema_version`: required, exactly `"review-comments/v1"`.
- `threads`: required array. Every entry is an object with:
  - `thread_id`: required, non-empty string (maximum 256 UTF-8 bytes, no NUL).
  - `is_ours`: required boolean, computed by the producer.
  - `mentions_bot`: required boolean, computed by the producer.

Optional context fields used for review/verification (for example anchors, resolved state, verdict history, and `comments` entries with `author`, `role`, and `body`) may be present. They are context for the agent, not aliases for the required scope fields and not interpreted by `submit_reply`.

The whole document and every thread are validated before use. Missing, null, incorrectly typed, unversioned, or differently versioned input returns `invalid_context` and writes nothing. Replies are allowed only when `is_ours || mentions_bot`; `resolve` and `reopen` additionally require `is_ours`.

## `review-reply/v1`

Accepted replies append one compact JSON object per line to `$HOME/review-output/replies/<writer>.jsonl`. Nothing is posted.

Fields:

- `schema_version`: exactly `"review-reply/v1"`.
- `id`: `<writer>-<seq>`.
- `writer`: the process writer name.
- `seq`: contiguous positive sequence, starting at 1.
- `created_at`: RFC 3339 UTC timestamp.
- `thread_id`: the validated existing thread ID.
- `body`: non-empty string, maximum 64 KiB in UTF-8, no NUL.
- `action`: `resolve`, `reopen`, or `none`.
- `verdict`: optional for mention-only threads; required for our threads. One of `fixed`, `not_fixed`, `partially_fixed`, `no_longer_applicable`, `regressed`, or `unverified`.
- `evidence_kind`: optional for mention-only threads; required for our threads. One of `code_reference`, `existing_test`, `new_test`, or `none`.
- `evidence`: optional for mention-only threads; required (possibly empty) for our threads, maximum 16 KiB in UTF-8, no NUL.

A writer file holds at most 30 replies. Counting, sequence assignment, and append happen under the writer lock and survive process restarts.

The local tests include accepted in-scope replies, missing/invalid context, unknown and out-of-scope threads, forbidden actions, missing verification fields, exact artifact content, and a fresh process enforcing the 30-reply cap. Reply cases will join the shared finding/summary fixture when the consumer side supplies `comments.json` and expected reply artifacts; the vendored fixture is not changed locally.
