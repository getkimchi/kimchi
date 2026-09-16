# Compaction repair pilot

This pilot did not establish a quality benefit from messages or the board. The fixed budget stopped the trials before they completed the repair workflow. Their saved outputs remain useful evidence of execution cost and failure modes, but they are not completed solutions.

## Comparison

The task was Kimchi's historical mid-turn compaction bug: continuation must finish within the original awaited request, retain safe tool pairing, support repeated compaction and handle cancellation and session changes. The broken source is `76337bd7`; the reference is `716bd797`. The [grader preflight](compaction-preflight.json) builds both and distinguishes them through real-process continuation and cancellation checks. Four adapter-specific diagnostics are reported separately.

Eight isolated built-Kimchi sessions ran through TMUX on `glm-5.3-flash`, with low thinking. Each arm ran twice; the second batch reversed the launch order. All participants could read the same source and shared files. Worker Ferment was off. Team arms had three initial workers with separate ownership and one subsequent repair worker; the parent coordinated without doing production repairs. This follows the harness's delegation guard. Communication was voluntary.

Each trial allowed 60,000 output tokens, two million total recorded tokens including cached input, and 18 minutes. Parent and worker usage both counted. These are recorded tokens, not billed cost. The monitor checks completed responses, so in-flight responses can exceed the limit. Trials within a batch ran concurrently; backend and machine contention prevent a clean latency claim.

The protocol and inputs were frozen before inference at `50227686`; the product binary came from `97d528a4`. The sandbox passed 74 checks covering isolation and public tooling. An earlier preflight failed because Vitest could not write its cache under read-only dependencies; that attempt is retained. Every trial received a writable cache directory before launch. Actual provider requests were audited for unavailable tools.

## Results

All eight trials hit the total-token cap, using 2.01–2.05 million recorded tokens each. None of the six team trials launched the repair worker. Across the cohort, recorded usage was 1,773,868 input tokens, 14,265,600 cached-input tokens and 173,527 output tokens. The input-inclusive cap ended work well before the output cap.

| Arm | Completed workflow | Build passed | Continuation check |
|---|---:|---:|---|
| Solo | 0/2 | 0/2 | Not runnable |
| Ordinary workers | 0/2 | 0/2 | Not runnable |
| Messages | 0/2 | 1/2 | Failed on the buildable output |
| Messages and board | 0/2 | 2/2 | Failed on both outputs |

The three buildable outputs left source unchanged. They passed their existing public tests, typecheck and style check, but each failed continuation and passed cancellation, matching the broken baseline. Each also failed all four adapter diagnostics. The other five outputs failed their own tests and typechecking, so the normal build could not produce binaries for process grading. No protected task, manifest or patch files changed.

The board trials returned 8 and 30 entry bodies. The trace identified 4 and 16 as known peer returns; the second trial also has unclassified returns because terminal identity records are incomplete. Every returned entry title came from automatic TODO progress. Neither board trial changed production source before the cutoff. This establishes channel activity, not a repair benefit. The messages trials did not complete a recorded question-and-answer exchange.

One board trial launched its three initial workers across separate batches after rejected calls. It does not provide the intended full peer group. Malformed tool names also occurred in several trials. These failures remain part of the evidence; they are not attributed to communication without a separate reproduction.

No code-quality, readability, cohesion or performance improvement was established. The incomplete outputs do not support ranking the arms. Passing existing checks, writing more code and reading progress entries each differ from completing the repair.

All eight TMUX sessions and their captured process trees stopped; all copied credential homes were removed. Post-run review found a monitor bug: absent terminal records could be mistaken for completed workers. The corrected monitor checks accepted launches and child sessions as well. Its regression failed before the fix and passes afterward. All eight cohort stops were caused by the token cap, so this bug did not determine their termination.

## What this changes

A completed-work comparison needs a budget calibrated on separate setup runs and frozen before the comparison, with a fixed allocation reserved for integration and repair. The current results must not be silently replaced by a larger-budget rerun. Launch grouping and actual tool use also need to be recorded alongside final scores.

The [research](communication-research.md) still supports selective communication when one worker discovers evidence another needs. This pilot supplies no reason to require posts or expand the board. A future value claim needs a received finding, a dependent change, an independent behavioral improvement and a comparison that reaches the same completion stage.

The [runner documentation](../../scripts/agent-communication/README.md) describes preparation, isolation, freezing, execution and grading. Machine-local captures are retained at `/private/tmp/kimchi-compaction-arms-xzaj19xq`; the [sanitized evaluation](compaction-pilot-evaluation.json) contains per-trial usage, tool observations, launch batches, changed files and check results.
