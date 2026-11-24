# Reviewer submit-tools contract v1

The `v1/` directory is the reviewer submit-tools contract v1 shared with the platform's code reviewer. It pins provider-derived context, scripted tool calls, and expected findings and summary artifacts.

The data files must remain byte-identical with the consumer's copy and change together with it. `v1/README.md` is Kimchi-side documentation for this checkout; it does not describe upstream repository locations or revisions.

`contract.test.ts` copies the context into a temporary fixture base directory and passes its sibling `review-context/` and `review-output/` paths explicitly to the production store. It does not use home-directory selection. The fixed timestamp and writer limit come from `calls.json`; repeated and generated calls are expanded before each invocation. Parallel steps run concurrently. Distinct `process` names are separate long-lived OS processes, including the two same-writer lock-racing processes. Results are checked against every expected outcome, then findings and summaries are compared with the expected JSON and JSONL records.

Reply coverage remains in the co-located local process tests until the consumer supplies comments context and expected reply artifacts for the shared fixture.
