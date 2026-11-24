# Reviewer submit-tools contract v1

This reviewer submit-tools contract v1 is shared with the platform's code reviewer. It pins `review-context/`, the calls in `calls.json`, and the exact expected findings and summary records in `review-output/`.

All data files in this directory must stay byte-identical with the consumer's copy and change together with it. This README is Kimchi-side documentation for running the fixture; do not use it as consumer input.

## How the Kimchi test runs the fixture

1. Copy `review-context/` into a temporary `HOME`; output goes to `$HOME/review-output/`. The fixture runs without provider credentials or package-manager network access. The tools have no network or posting capability.
2. Set the clock to `fixed_created_at` from `calls.json`, set `REVIEW_WRITER_LIMIT=50`, and set `REVIEW_WRITER` from each call's `writer` field.
3. Execute steps in order. Expand `repeat` into sequential calls and run calls marked `parallel` concurrently.
4. Keep calls with the same `process` name in one long-lived OS process; use separate processes for distinct names. This includes both same-writer racing processes, not concurrent functions within one store.
5. Materialize `generate_string_bytes` and `generate_array_lengths` before each call, then pass the expanded arguments to the production submit functions.
6. Assert every expected structured outcome and human-readable message. This covers anchor diagnostics, finding and summary validation, `derived_from`, `environment_gaps`, caps, and stable IDs.
7. Compare the resulting findings and summaries semantically with `review-output/`. Rejected calls add no records; accepted records have contiguous per-writer sequences, and concurrent appends remain whole JSONL lines.

The fixture uses `review-finding/v1` and `review-summary/v1`. Reply validation and exact reply artifacts are covered by co-located local process tests. Reply cases join this shared fixture when the consumer supplies `comments.json` and expected reply output.
