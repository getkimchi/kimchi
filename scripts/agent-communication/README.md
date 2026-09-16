# Communication trace inspection

Run `python3 scripts/agent-communication/trace.py /path/to/run/sessions` against a completed capture. It prints a JSON report without copying message bodies or shell commands. Run its checks with `python3 scripts/agent-communication/trace.test.py`.

The report separates successful board reads from count/title hints, repeated reads from unique reader/entry pairs, and a worker's own posts from known peer posts. Parent reads are counted separately. Worker identity comes from the parent's persisted `subagents:record` entries; missing identity stays unclassified.

Directed messages are correlated through tool calls and host receipts. An accepted reply means the host accepted a reply referencing the question. It does not prove delivery or answer quality. A question with no recorded accepted reply may have been resolved in a shared artifact, another channel or a missing capture. Non-JSON results and unmatched calls remain warnings; they never count as successful communication.

Usage includes every supplied session, including parents, workers and evaluators. Supply the complete session directory to compare against a run's totals. The script counts recorded attempts across all branches; it does not reconstruct a final conversation branch or estimate billing. Duplicate session captures and malformed JSON fail explicitly.

Artifact actions carry source locations so a reviewer can inspect what followed a read or reply. The script does not infer understanding or causal benefit. A useful-exchange claim still needs the relevant input, source change, independent verification and alternative explanations described in the [research comparison](../../docs/subagentComms/communication-research.md#a-more-informative-comparison).
