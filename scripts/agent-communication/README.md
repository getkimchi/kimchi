# Communication trace inspection

Run `python3 scripts/agent-communication/trace.py /path/to/run/sessions` against a completed capture. It prints a JSON report without copying message bodies or shell commands. Run its checks with `python3 scripts/agent-communication/trace.test.py`.

The report separates successful board reads from count/title hints, repeated reads from unique reader/entry pairs, and a worker's own posts from known peer posts. Parent reads are counted separately. Worker identity comes from the parent's persisted `subagents:record` entries; missing identity stays unclassified.

Directed messages are correlated through tool calls and host receipts. An accepted reply means the host accepted a reply referencing the question. It does not prove delivery or answer quality. A question with no recorded accepted reply may have been resolved in a shared artifact, another channel or a missing capture. Non-JSON results and unmatched calls remain warnings; they never count as successful communication.

Usage includes every supplied session, including parents, workers and evaluators. Supply the complete session directory to compare against a run's totals. The script counts recorded attempts across all branches; it does not reconstruct a final conversation branch or estimate billing. Duplicate session captures and malformed JSON fail explicitly.

Artifact actions carry source locations so a reviewer can inspect what followed a read or reply. The script does not infer understanding or causal benefit. A useful-exchange claim still needs the relevant input, source change, independent verification and alternative explanations described in the [research comparison](../../docs/subagentComms/communication-research.md#a-more-informative-comparison).

## Historical compaction workload

Run `python3 scripts/agent-communication/preflight-compaction.py` to build the historical broken and fixed revisions in new temporary directories. The script uses the checkout's installed dependencies, runs identical real-process tests against both binaries and retains build logs, JSON results, source references and file hashes. It expects the continuation test to fail on the baseline and pass on the reference; cancellation must pass on both. An unexpected result stops the preflight.

The workload concerns a long tool chain that crosses the context limit while still running. A successful repair must finish within the original awaited request, compact the context seen by subsequent requests, preserve tool-call/result pairing and stop cleanly on cancellation. Further checks must cover repeated pressure, ineffective compaction and session changes before judging a complete repair. Passing the initial two process tests is insufficient for that broader claim.

These directories contain the reference solution and grader, so they are for evaluation setup only. Agent trials need fresh baseline archives, isolated credentials and execution environments, and no access to this reference copy. Every arm must retain access to the same baseline source and public task artifacts. The four-arm comparison itself is not launched by this script.
