# Communication trace inspection

Run `python3 scripts/agent-communication/trace.py /path/to/run/sessions` against a completed capture. It prints a JSON report without copying message bodies or shell commands. Run its checks with `python3 scripts/agent-communication/trace.test.py`.

The report separates successful board reads from count/title hints, repeated reads from unique reader/entry pairs, and a worker's own posts from known peer posts. Parent reads are counted separately. Worker identity comes from the parent's persisted `subagents:record` entries; missing identity stays unclassified.

Directed messages are correlated through tool calls and host receipts. An accepted reply means the host accepted a reply referencing the question. It does not prove delivery or answer quality. A question with no recorded accepted reply may have been resolved in a shared artifact, another channel or a missing capture. Non-JSON results and unmatched calls remain warnings; they never count as successful communication.

Usage includes every supplied session, including parents, workers and evaluators. Supply the complete session directory to compare against a run's totals. The script counts recorded attempts across all branches; it does not reconstruct a final conversation branch or estimate billing. Duplicate session captures and malformed JSON fail explicitly.

Artifact actions carry source locations so a reviewer can inspect what followed a read or reply. The script does not infer understanding or causal benefit. A useful-exchange claim still needs the relevant input, source change, independent verification and alternative explanations described in the [research comparison](../../docs/subagentComms/communication-research.md#a-more-informative-comparison).

## Historical compaction workload

Run `python3 scripts/agent-communication/preflight-compaction.py` to build the historical broken and fixed revisions in new temporary directories. The script uses the checkout's installed dependencies, runs identical real-process tests against both binaries and retains build logs, JSON results, source references and file hashes. It expects the continuation test to fail on the baseline and pass on the reference; cancellation must pass on both. An unexpected result stops the preflight.

The workload concerns a long tool chain that crosses the context limit while still running. A successful repair must finish within the original awaited request, compact the context seen by subsequent requests, preserve tool-call/result pairing and stop cleanly on cancellation. Four additional unit diagnostics cover repeated pressure, ineffective compaction, unpaired tool calls and session changes. They assume the existing inline-compaction adapter and diagnostic events. Keep their scores separate from process behavior when assessing an alternative implementation.

These directories contain the reference solution and grader, so they are for evaluation setup only. Agent trials need fresh baseline archives, isolated credentials and execution environments, and no access to this reference copy. Every arm must retain access to the same baseline source and public task artifacts. The four-arm comparison itself is not launched by this script.

## Local four-arm pilot

`prepare-experiment.py` prepares eight macOS sandbox homes without inference. It currently depends on the local glm-5.3-flash provider configuration and a pnpm 10.8.1 copy from the earlier fixture; change that source path for another machine. Credentials stay in temporary homes. `check-isolation.py ROOT` verifies read/write boundaries and public test tooling before any trial starts. Dependency packages are read-only; each workdir has writable cache directories.

The arms are solo, ordinary workers with shared files, workers with messages, and workers with messages plus board. Each repeats twice, with reversed launch order. All use the same built Kimchi, task source, low-thinking model, ordinary TODOs and disabled worker Ferment. Team arms have three initial workers with distinct ownership, then one bounded repair worker. The parent inspects and coordinates but does not perform production repair; this respects Kimchi's native delegation guard. Shared files remain available in every arm, and communication is voluntary.

After checking the prepared files, run `python3 scripts/agent-communication/run-experiment.py ROOT --seal`. This freezes source, task, prompts, settings, extension and binary hashes. Then run the same script with `ROOT trial-01 trial-02 trial-03 trial-04`, followed by trials 05–08. Each batch runs concurrently through the bundled TMUX controller. Backend contention means elapsed time is descriptive, not a clean latency comparison. The monitor includes parent and worker tokens, including cached input. Its response-boundary budget can overshoot with concurrent or in-flight responses; retain the observed excess.

`experiment.ts` enforces launch parameters and masks unavailable channels in actual provider requests, which it audits separately from tool activation. Check those observations before treating a trial as valid. Wrong staffing, failed launch grouping, missing request observations or changed protected files invalidate the relevant comparison; preserve them without automatic retries. Final source is copied atomically only after the trial's own TMUX process tree stops. Temporary credential homes are removed at completion. An interrupted runner retains its receipt: inspect and clean up that existing run, never restart it blindly.

Grade final snapshots outside the model sandbox using the frozen process checks and separate adapter diagnostics. Also run each candidate's tests, typecheck and style check, and inspect the diff for cohesive integration. The pilot measures final outcomes; it does not capture an exact pre-repair handoff or establish broad communication value from one task family.
