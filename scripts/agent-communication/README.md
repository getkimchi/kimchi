# Communication trace inspection

## Current build versus ordinary subagents

`normal-comparison.py prepare` builds the current checkout, verifies that source stayed unchanged during the build, and freezes the runtime and comparison inputs. It preserves local modifications; no earlier evaluation report is used as build provenance. `run ROOT`, `grade ROOT`, then `normal-report.py ROOT` produce eight isolated trials and a report using the existing agreement fixture. Both arms use two ordinary workers, the same model and file access; the enabled arm also has communication and reconciliation tools. Ferment is off. Run `normal-comparison.py --self-check` to check provenance handling and the fixture. Results and complete commands: [normal comparison](../../docs/subagentComms/normal-comparison.md).

## Changing a shared agreement

`agreement-diagnostic.py` runs a small calibration matrix: shared files and parent coordination, directed messages, and messages plus board. Each condition gets changed, unchanged, and mistaken-advisory evidence. Two real workers own the encoder and decoder. The host publishes the new evidence after the first observed component edit; every arm retains the same files and parent repair route.

```sh
python3 scripts/agent-communication/agreement-fixture.py
python3 scripts/agent-communication/agreement-diagnostic.py prepare
python3 scripts/agent-communication/agreement-diagnostic.py run ROOT
python3 scripts/agent-communication/agreement-diagnostic.py grade ROOT
```

Replace `ROOT` with the prepared directory. `run` also accepts case names: `changed`, `unchanged`, `mistaken`. It runs three isolated TMUX sessions concurrently per case and retains every attempt. The adapter reuses the delivery build and sandbox setup, channel masking, lifecycle accounting, snapshots and trace analysis. The delivery command remains registered but is never invoked. All parent and worker inference uses `glm-5.3-flash`, low reasoning and Ferment disabled. Each trial has a 300-second wall limit, 25,000 output-token limit and 1,000,000 total recorded-token limit, including cache reads.

The frozen protocol lives in `agreement-seal.json` and `protocol-source/`; the manifest also retains the reused delivery build's provenance. Independent checks cover each component against the external format, batches, input preservation and invalid inputs. Source snapshots are sampled every 300 ms, so their timestamps approximate edit completion and may miss transient writes. Inspect session tool calls before crediting a message for an edit. Results: [agreement comparison](../../docs/subagentComms/agreement-comparison.md).

## Delivery diagnostic

`delivery-diagnostic.py` compares ordinary artifacts, an early message, a board finding and a message after the first consumer edit. It builds a disposable instrumented Kimchi binary and uses the bundled TMUX controller with isolated homes and a macOS sandbox. The source is an evaluator-controlled queued worker that sends one verified finding through native product routes; it performs no inference. The recipient uses `kimchi-dev/glm-5.3-flash`, low reasoning and Ferment disabled in every condition.

```sh
python3 scripts/agent-communication/delivery-diagnostic.py prepare
python3 scripts/agent-communication/delivery-diagnostic.py checkpoint ROOT
python3 scripts/agent-communication/delivery-diagnostic.py run ROOT
python3 scripts/agent-communication/delivery-diagnostic.py grade ROOT
python3 scripts/agent-communication/delivery-report.py ROOT
```

Replace `ROOT` with the directory printed by `prepare`. The eight trials run in reversed order for the second repetition. `run` and `grade` also accept explicit labels such as `trial-01`. Existing attempts are never overwritten. Inspect the saved checkpoint before starting comparisons; it may already contain the recipient's hypothesis. The driver freezes inputs, captures provider requests and edits, stops its own sessions and removes temporary credential homes. Local audit files contain full model payloads and should remain local.

The report verifies body delivery, checkpoint and tool-schema equivalence, model selection, protected files, cleanup and inference accounting. Native usage totals include the copied checkpoint: the report subtracts that history from each continuation and reports the checkpoint's one-time usage separately. Saved edits are graded after execution under the same sandbox. Version 2 has 15 frozen checks and explicitly specifies the status after a cancellation request. It includes the unstarted-attempt case discovered during version 1 calibration; that earlier cohort retains its original scores and separate supplement. Neither a read nor a passing score establishes a causal communication benefit.

Run the fixture self-check with `python3 scripts/agent-communication/delivery-fixture.py`, body-detection checks with `python3 scripts/agent-communication/delivery-report.py --self-check`, and timing checks with `pnpm exec vitest run scripts/agent-communication/delivery-probe.test.ts`. Results and limitations: [delivery comparison](../../docs/subagentComms/delivery-comparison.md).

## Existing trace reports

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

`prepare-experiment.py` prepares eight macOS sandbox homes without inference. It defaults to the local glm-5.3-flash provider configuration; `--model kimi-k3` selects another configured kimchi-dev model. The frozen manifest supplies the parent model, worker instructions and launch checks. Use a fresh cohort when changing models and report its results separately. Preparation copies the installed pnpm distribution into the private toolchain. Credentials stay in temporary homes. `check-isolation.py ROOT` verifies read/write boundaries and public test tooling before any trial starts. Dependency packages are read-only; each workdir has writable cache directories.

For separate budget calibration, preparation accepts `--purpose calibration --arms solo workers --max-total-tokens 12000000 --wall-seconds 1800`. The default comparison remains unchanged. Calibration receipts must stay separate from comparison results; changing a limit does not justify replacing an earlier attempt.

The arms are solo, ordinary workers with shared files, workers with messages, and workers with messages plus board. Each repeats twice, with reversed launch order. All use the same built Kimchi, task source, low-thinking model, ordinary TODOs and disabled worker Ferment. Team arms have three initial workers with distinct ownership, then one bounded repair worker. The parent inspects and coordinates but does not perform production repair; this respects Kimchi's native delegation guard. Shared files remain available in every arm, and communication is voluntary.

After calibration, the protocol reserves 20,000 output tokens for the repair worker, matching the implementation owner; each investigator retains 10,000. All team prompts explain how to yield or retrieve results without shell waiting. This is a common protocol instruction, not a measured product improvement. Prepare the next separate comparison with `--purpose comparison --max-total-tokens 24000000 --max-output-tokens 80000 --wall-seconds 1800`. Grade all eight saved outputs with both `--repeated` and `--contracts`, retain early stops as unsuccessful attempts, and report process checks, lifecycle checks, own checks and completed workflows separately. These limits and instructions must be frozen before inference; they do not replace the original pilot or calibration.

After checking the prepared files, run `python3 scripts/agent-communication/run-experiment.py ROOT --seal`. This freezes source, task, prompts, settings, extension and binary hashes. Then run the same script with `ROOT trial-01 trial-02 trial-03 trial-04`, followed by trials 05–08. Each batch runs concurrently through the bundled TMUX controller. Backend contention means elapsed time is descriptive, not a clean latency comparison. The monitor includes parent and worker tokens, including cached input. Its response-boundary budget can overshoot with concurrent or in-flight responses; retain the observed excess.

`experiment.ts` enforces launch parameters and masks unavailable channels in actual provider requests, which it audits separately from tool activation. Check those observations before treating a trial as valid. Wrong staffing, failed launch grouping, missing request observations or changed protected files invalidate the relevant comparison; preserve them without automatic retries. Final source is copied atomically only after the trial's own TMUX process tree stops. Temporary credential homes are removed at completion. An interrupted runner retains its receipt: inspect and clean up that existing run, never restart it blindly.

Run `python3 scripts/agent-communication/grade-experiment.py ROOT trial-01 trial-02` with the desired completed labels to grade copies outside the model sandbox. It runs candidate tests, typecheck, style and build before overlaying the frozen process checks and separate adapter diagnostics. An unbuildable output has no process score. Inspect the diff for cohesive integration as well. The pilot measures saved outcomes; it does not capture an exact pre-repair handoff or establish broad communication value from one task family. The [first pilot report](../../docs/subagentComms/compaction-pilot.md) records eight budget-limited attempts and their limitations.

Add `--repeated` to run the supplemental two-cycle process probe after the original checks. It applies `repeated-compaction.diff` only to the disposable grading fixture. The [separate preflight](../../docs/subagentComms/compaction-repeat-preflight.json) records the original fixture hash, patch hash, unchanged binary hashes and both revision results. The reference passes repeated continuation and cancellation; the broken revision fails continuation. Initial fixture failures are retained: an updated-summary request needs the summarizer system-message route, and cancellation during the first summary must still expect only one summary. Each tool call has a distinct ID, and pairing checks require its call to precede the result. Original pilot scores remain unchanged.

Add `--contracts` for six supplemental lifecycle checks that do not require diagnostic names or notification wording. They use the existing inline adapter and synchronize branch and cached context fixtures. The [preflight](../../docs/subagentComms/compaction-contract-preflight.json) records reference 6/6 and baseline 0/6, along with post-run calibration diagnostics and retained fixture errors. The patch applies only to a grading copy, and the reference fixture typechecks.

Those checks still assume particular event and session APIs. The later [comparison](../../docs/subagentComms/compaction-comparison.md) found valid alternatives: reading entries and a leaf ID, checking `turn_end.toolResults`, or compacting at the next context event. In a disposable grading copy where `--contracts` has already applied its fixture, `git apply /absolute/path/to/event-compaction.diff` supplies consistent history and event fields, creates fresh contexts as Pi does, and follows tool-use responses into the context event. Run `pnpm exec vitest run src/extensions/model-guard.test.ts -t 'event contract:'` there. The reference passes 6/6 and typechecks; the broken baseline fails 6/6. This is a post-output supplement, not a replacement for frozen scores or real-process checks.

The monitor now requires the parent’s settled event to follow its latest provider request. A saved assistant error can remain at the end of the session file while a retry is already streaming; that is not completion. Worker termination checks still apply. The comparison also retains a solo attempt blocked by an approval prompt under `auto` permissions. Its test command had not executed, so its elapsed time is not a completed-repair latency measurement.

`probe-parent-wait.py` prepares and freezes four short isolated waiting probes without starting inference. Run the printed root through `run-experiment.py` with all four labels. The conditions differ only in parent waiting guidance; each delegates one delayed JSON artifact and verifies it. Inspect actual launches, terminal results and artifact bytes: a parent that merely announces its next action has not completed the task. The [first results](../../docs/subagentComms/parent-wakeup-evaluation.json) include three such early stops and one successful native wait, so they establish no guidance benefit.

## OAuth repair comparison

`oauth-comparison.py` reuses the runner for a historical three-module repair. Build with `pnpm run build:binary`, then prepare with `python3 scripts/agent-communication/prepare-experiment.py --oauth --arms solo workers board board workers solo --wall-seconds 600 --max-output-tokens 30000 --max-total-tokens 2000000`. Preparation prints `ROOT` and starts no inference.

Run `check-isolation.py ROOT`, then `oauth-comparison.py preflight ROOT`. The public suite must distinguish broken 47/53 from reference 53/53; both must typecheck. Run `oauth-comparison.py ROOT --seal`, then the same command with `ROOT trial-01 trial-02 trial-03`. After those sessions finish and clean up, run `ROOT trial-04 trial-05 trial-06`. Confirm actual provider requests and inspect visible approval prompts; controller success alone is insufficient. Record any authorized input intervention.

Run `oauth-comparison.py grade ROOT trial-01 trial-02 trial-03 trial-04 trial-05 trial-06` once per capture. It writes fresh `grade-v2` copies, preserves all production edits, restores modified grading inputs, and records scope violations separately. Existing grading copies are never overwritten. Check added tests too. `oauth-refresh.diff` adds a separate real-SDK discovery regression to a disposable grading copy; run its colocated test with `pnpm exec vitest run src/extensions/mcp-adapter/refresh-discovery-regression.test.ts`. It was added after first-output review, so report it separately from the frozen score.

The [comparison report](../../docs/subagentComms/oauth-comparison.md) retains fourteen attempts, including a failed team launch, native thinking change, approval interruption, grading correction and intermittent callback failure. A passing artifact is not a completed workflow, and a solo fallback is not communication evidence.

Launch rejections now distinguish expected values from received values and state that no worker started. This experiment-only correction preserves the original staffing rules and budgets. Its native recovery probe and four fresh repeats remain separate from the original cohort.

Every parent in those four repeats reached the global token ceiling before final review. To reproduce the separate completed-pair calibration, prepare with `--oauth --purpose calibration --arms workers board --wall-seconds 1200 --max-output-tokens 80000 --max-total-tokens 12000000`, then use the same isolation, preflight, seal, run and grading commands for trials 01–02. Per-worker limits stay unchanged. Preserve both the monitor's stop usage and final trace usage: a response can finish during shutdown. Inspect whether the channels were used before attributing any outcome to communication.

## Explicit communication workflow

The [communication-use report](../../docs/subagentComms/communication-use.md) separates four prompt-guidance attempts from two runs that explicitly requested cross-review. To repeat the latter, prepare with `--oauth --purpose comparison --arms board board --wall-seconds 1200 --max-output-tokens 80000 --max-total-tokens 12000000`. Set `ROOT` to the printed capture directory. Before sealing or starting inference, append the retained [cross-review brief](communication-brief.md):

```bash
python3 - "$ROOT" <<'PY'
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1])
assert not (root / "seal.json").exists(), "Use a fresh, unsealed capture"
brief = Path("scripts/agent-communication/communication-brief.md").read_bytes()
manifest = json.loads((root / "manifest.json").read_text())
paths = [root / "seed/TASK.md", *(root / t["label"] / "probe/TASK.md" for t in manifest["trials"])]
assert all(brief not in path.read_bytes() for path in paths), "Brief already applied"
for path in paths:
    path.write_bytes(path.read_bytes() + b"\n" + brief)
(root / "communication-brief.md").write_bytes(brief)
manifest["purpose"] = "explicit-communication-use"
manifest["communication_brief_sha256"] = hashlib.sha256(brief).hexdigest()
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
PY
```

Use the same isolation, preflight, seal, run and grade commands for trials 01–02. Check accepted message receipts against recipient histories, board bodies returned to peers, subsequent source checks and final outputs. Retain malformed calls, rejected replies, missing review steps and worker budget stops. This task explicitly requests communication; it does not test spontaneous adoption or isolate a quality gain against ordinary workers.
