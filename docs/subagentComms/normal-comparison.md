# Current communication versus ordinary subagents

The latest eight runs show equal correctness and mixed output quality. Both modes passed 72/72 checks at worker handoff and in the final code. Communication used 3.4% more output tokens and 51.2% more recorded input tokens. This comparison does not establish a quality improvement.

## After progress-snapshot replacement

| Four runs per mode | Ordinary subagents | Communication enabled |
|---|---:|---:|
| Handoff and final checks, each | 72/72 | 72/72 |
| Output tokens | 28,770 | 29,753 |
| Recorded input tokens | 108,030 | 163,304 |
| Outputs duplicating decoder responsibilities | 1/4 | 0/4 |
| Outputs with tests requiring unavailable pytest | 0/4 | 2/4 |

These are four runs times 18 correlated checks within the same small event-bridge task. Both modes used the same freshly built binary, `kimchi-dev/glm-5.3-flash`, low reasoning, source access and budgets. Ferment was disabled. Two changed-contract and two mistaken-advisory cases ran per mode. Cache-read tokens were 1,311,872 for normal and 1,585,984 for enabled runs; no dollar-cost estimate was made.

One normal producer duplicated `decode` and `decode_many`. Enabled outputs kept those responsibilities in the consumer, but two retained producer tests importing unavailable `pytest`. Another enabled test file only defined functions, so executing it ran no assertions. The last pair saved no test files; its agents used inline checks. All final outputs passed the independent grader and public endpoint check. This supports equal functional correctness here, with no consistent test-quality or readability advantage. Runtime performance was not measured.

There were eleven peer-entry body returns. Each enabled run read a peer work entry before the first observed passing implementation. That timing does not prove the entry supplied a missing fact: the first changed-case consumer had already read revision 2 before reading its peer's TODO. No run used directed messages, reconciliation or resumed workers. One normal parent changed `int(ts)` to `round(ts)`; its handoff already passed all frozen checks.

The first preparation retained four attempts before scheduling was stopped. One normal attempt launched no workers because the parent treated the experiment's launch rejections as successful launches. The fresh cohort supplied exact launch arguments and explicit rejection handling to both modes; all sixteen workers then launched without rejection. The preliminary scores remain in the data, outside the corrected comparison: changed normal 2/18, changed enabled 18/18, mistaken normal 17/18, mistaken enabled 18/18. Product sources and binary were identical across preparations.

Two corrected-cohort prompts remained pasted in the TMUX editor before any provider request. Submitting Enter once delivered each original prompt; neither task nor wall limit changed. Raw elapsed time includes those delays, so it is not evidence of a speed difference. All twelve attempted sessions stopped and their copied credential homes were removed. Source replay matched all eight corrected final artifacts; channel access, model, protected files and isolation checks passed.

[Current results and retained attempts](normal-snapshot-evaluation.json) include the input interventions, provenance and individual scores. Captures: `/private/tmp/kimchi-normal-comparison-90djoie3` and `/private/tmp/kimchi-normal-comparison-m5bxi_82`. The earlier enabled score below was 69/72. Sampling variation and the clarified launch instructions prevent attributing its change to 72/72 to snapshot replacement.

## Earlier cohort

This eight-run comparison found no improvement over ordinary subagents. Communication-enabled outputs passed 69/72 independent checks, versus 72/72 for controls, and used 13.3% more output tokens. One enabled output duplicated the decoder inside the producer. These results do not establish that communication caused the defects; they provide no quality or cohesion gain for this task.

“Normal” here means two ordinary subagents with shared files and parent coordination. It does not mean a single agent. Both arms used the current built binary, `kimchi-dev/glm-5.3-flash`, low reasoning, identical budgets and disabled Ferment. The enabled arm had messages, the board and `reconcile_agent_result`. The control retained ordinary TODOs, worker results, parent steering and all task files.

| Four runs per arm | Ordinary subagents | Communication enabled |
|---|---:|---:|
| Worker handoff checks | 72/72 | 69/72 |
| Final checks | 72/72 | 69/72 |
| Parent production edits | 0 | 0 |
| Output tokens | 37,289 | 42,230 |
| Recorded input tokens | 144,896 | 193,922 |
| Cache-read tokens | 1,660,096 | 1,626,240 |
| Mean completion time | 124.6 s | 135.2 s |

Each denominator is four runs times 18 checks. The checks are correlated cases within one task, not 72 independent experiments. Times include parent and worker work and five seconds of settlement observation; pairs ran concurrently against the same backend. They do not establish a reliable speed difference. Token totals include rejected calls and all saved inference, without an estimated dollar cost.

Two workers extended an event encoder and decoder. After the first component edit, the host either changed the authoritative endpoint format from seconds to milliseconds or kept seconds while publishing a mistaken milliseconds advisory. Each case ran twice per arm, with launch order reversed for the second repetition. No attempts were excluded or retried.

| Case | Normal, repeat 1 | Enabled, repeat 1 | Normal, repeat 2 | Enabled, repeat 2 |
|---|---:|---:|---:|---:|
| Changed contract | 18/18 | 18/18 | 18/18 | 18/18 |
| Mistaken advisory | 18/18 | 15/18 | 18/18 | 18/18 |

The 15/18 output used incorrect floating-point correction: decoding `1.001` seconds returned `1000` milliseconds instead of `1001`; the negative case and batch check also failed. Its public endpoint check passed. It consumed no peer messages or board bodies, so this failure cannot be attributed to a received finding. The parent made no repair.

All workers kept production writes inside their assigned files. That did not guarantee cohesive responsibilities: the second enabled changed-contract producer also defined `decode` and `decode_many`, duplicating the consumer's job. The duplicate functions appeared before peer board consumption. Its producer test exercised that duplicate decoder, so a passing local round-trip test did not establish coverage of the separate consumer.

The enabled runs returned ten known peer-entry bodies. Every such read occurred after the corresponding output already passed all 18 independent checks. The first changed-contract run also sent an accepted status and attempted an invalid reply to it. The second exchanged an accepted question and answer after both components were correct. There were no resumed worker turns and no reconciliation calls in either arm. The recent stale-question fix was available but not exercised; its specific before/after result remains in [reconciliation evaluation](reconciliation-evaluation.json).

Removing mandatory worker rereads from the top-level task did not remove them from execution. In all four changed-contract runs, the parent independently instructed the consumer to reread the authoritative contract. Ordinary source access and parent coordination therefore continued to make recovery cheap. The comparison measures these complete workflows, including their generated assignments; it does not isolate delivery to a worker that lacks a useful fact.

Saved test-file execution passed for all six files containing an explicit runner. One additional test file only defined functions and exited without exercising them. Unittest discovery found zero tests in all eight outputs; those results are recorded as no tests, not successful test suites. Inline checks remain in the session traces. No runtime-performance benchmark or independent style/readability score was collected.

Source reconstruction replayed successful production writes and edits and matched every final artifact exactly. The handoff uses the later of the two workers' first terminal records. Shell-command inspection found test-file writes but no additional production mutation. Actual provider tool lists matched each arm; all sixteen launches passed the experiment's parameter checks, and rejected launch attempts remain included in usage. Protected files were intact, every trial settled, all eight TMUX sessions stopped and copied credential homes were removed.

## Reproduce

The runner builds the current checkout with `pnpm run build:binary` and rejects source changes during preparation. It records HEAD, hashes of tracked and untracked source files, the build log and binary. Each repetition freezes the runtime resources, task, grader, driver and TMUX controller before inference. The existing agreement fixture retains its 18-check grader. Each trial has a 300-second wall limit, 25,000 output-token limit and 1,000,000 recorded-token limit including cache reads.

```sh
python3 scripts/agent-communication/normal-comparison.py prepare
python3 scripts/agent-communication/normal-comparison.py run ROOT
python3 scripts/agent-communication/normal-comparison.py grade ROOT
python3 scripts/agent-communication/normal-report.py ROOT
```

Replace `ROOT` with the directory printed by `prepare`. [Sanitized results](normal-evaluation.json) retain every score, usage total, source hash, test result and communication count. Frozen inputs and complete local traces are at `/private/tmp/kimchi-normal-comparison-fet8u3zh`. The exact-edit replay check runs with `python3 scripts/agent-communication/normal-report.py --self-check`.
