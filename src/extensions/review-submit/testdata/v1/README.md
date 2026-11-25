# Reviewer submit-tools contract v1

This reviewer submit-tools contract v1 is shared with the platform's code reviewer. It pins `review-context/`, the calls in `calls.json`, and the exact expected findings and summary records in `review-output/`.

All data files in this directory must stay byte-identical with the consumer's copy and change together with it. This README is Kimchi-side documentation for running the fixture; do not use it as consumer input.

## How the Kimchi test runs the fixture

1. Copy `review-context/` into a temporary fixture base directory and direct output to a sibling `review-output/` directory. Pass both directories explicitly as the tool context and output paths, with no home-directory fallback. Run without provider credentials or package-manager network access; the tools themselves make no network requests and never post a review.
2. Set the clock to `fixed_created_at` from `calls.json` and enable review mode with `--review`. Pass each call's `writer` through `--review-writer` and use `--review-writer-limit 50` for non-final writers; `final` always keeps the limit at 50.
3. Execute steps in order. Expand `repeat` into sequential calls and run calls marked `parallel` concurrently.
4. Keep calls with the same `process` name in one long-lived OS process; use separate processes for distinct names. This includes both same-writer racing processes, not concurrent functions within one store.
5. Materialize `generate_string_bytes` and `generate_array_lengths` before each call, then pass the expanded arguments to the production submit functions.
6. Assert every expected structured outcome and human-readable message. This covers anchor diagnostics, finding and summary validation, `derived_from`, `environment_gaps`, caps, and stable IDs.
7. Compare the resulting findings and summaries semantically with `review-output/`. Rejected calls add no records; accepted records have contiguous per-writer sequences, and concurrent appends remain whole JSONL lines.

The fixture uses `review-finding/v1` and `review-summary/v1`. Reply validation and exact reply artifacts are covered by co-located local process tests. Reply cases join this shared fixture when the consumer supplies `comments.json` and expected reply output.

## Panel manifest and stream records

`review-context/manifest.json` is the v1 headless panel manifest. It has exactly `schema_version`, `base_sha`, `head_sha`, `checkout_path`, `context_dir`, `output_dir`, and `deadline`. Its schema is `review-manifest/v1`; base/head match `provider-diff.json`, and deadline is an absolute UTC RFC 3339 timestamp. The paths and synthetic Git IDs document the wire contract; a live checkout test substitutes real temporary paths and revisions. There is no grace field: TERM occurs at `deadline` and KILL 60 seconds later.

A successful panel print JSON stream starts with the `session` header and an initial system message advertising `submit_finding`, `submit_summary`, and `submit_reply`. It needs no top-level assistant message, but must end with `agent_settled`. Harness setup has no `tool_execution_*` events. Child assistant messages stay out of the top-level stream.

Child cost reporting uses distinct `child_usage` records: `{ "type": "child_usage", "writer", "provider", "model", "usage", "parentToolCallId"? }`. `provider` and `model` identify the model that actually served the calls; `usage` contains only `input`, `output`, `cacheRead`, and `cacheWrite`. Records are differential aggregates per writer/provider/model, including reconciliation, and `parentToolCallId` is present only when a tool launched that child. The stream can also contain submit events during the TERM grace before `agent_settled`.
