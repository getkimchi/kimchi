# OAuth repair: communication versus normal workers

These runs do not establish better code quality from communication. The latest pair passed the public tests, types, style and refresh check, but both outputs failed an additional timeout-cleanup check. Neither used messages or board reads. Earlier attempts include unfinished repairs, a failed team launch and regressions in both modes.

Fourteen isolated built Kimchi sessions ran through TMUX on 2026-09-21: six initial attempts, four repeats after clarifying launch errors, two budget-calibration attempts and two current-build regression attempts. All are retained in [the results](oauth-evaluation.json). The final pair uses the later worker loop-guard fix; each cohort kept its own runtime unchanged during execution.

## Current-build regression pair

The worker loop guard now runs in every local worker. This pair checked it on the same OAuth coding task, beyond the small file tasks used to reproduce repetition. Task text, source, tests, prompts, model and limits match the calibration pair below; the built runtime includes the intervening board and worker fixes. Each mode ran once, with no outcome-based retries.

| Check | Normal workers | Communication enabled |
| --- | --- | --- |
| Frozen public tests | 53/53 | 53/53 |
| Types / scoped style | Pass / Pass | Pass / Pass |
| Separate refresh regression | Pass | Pass |
| Separate late-failure cleanup check | **Fail** | **Fail** |
| Worker outcomes | All three completed | All three completed |
| Loop-guard warnings / stops | 0 / 0 | 0 / 0 |
| Messages / board body returns | 0 / 0 | 0 / 0 |
| Added tests / out-of-scope edits | None / None | None / None |
| Recorded input, including cache | 1,912,079 | 1,223,256 |
| Output tokens | 19,692 | 18,985 |
| Elapsed seconds | 259.5 | 190.4 |

Both outputs extracted a helper shared by persistent and probe connections. Both put that helper inside the probe's timeout wrapper without stopping its later fallback. If the initial HTTP connection rejects after the probe has timed out and returned, the helper starts a second connection. The [additional check](../../scripts/agent-communication/oauth-timeout.diff) reproduces that behavior in both outputs; the historical reference passes. File ownership was respected, but the shared helper's lifetime was still wrong.

This check was written after reviewing the outputs and remains separate from the 53 frozen checks. Its initial version also required the historical reference to return a timeout error. That assertion failed because the reference completed its immediate fallback at the deadline. The retained, narrower check asks whether another connection starts after the probe returns. Both test versions and their results remain in the capture. To reproduce it, apply the patch to a disposable grading copy and run the colocated server-manager test with `-t 'does not start a fallback connection after the probe has returned'`.

The pair found no loop-guard interruption of coding, but six workers cannot establish its false-positive rate. Neither team exchanged messages or read board bodies, so the lower recorded usage in the enabled run does not establish communication value. Formatting passed in both; readability and generated-code performance were not measured.

Capture: `/private/tmp/kimchi-compaction-arms-k4bvnr1o`. Both parents finished and all six workers completed. Normal mode corrected one rejected launch. All 20 isolation/toolchain checks passed; 1,752 retained sealed inputs matched and four sealed home files had been removed by verified cleanup. Model, thinking level, channel masks and final trace usage were checked. Both TMUX sessions stopped and credential homes were removed.

## Earlier budget-calibration pair

The calibration pair kept the same task, binary, model, worker limits and ownership. Both parents could use up to 1,200 seconds, 80,000 output tokens and 12,000,000 total recorded tokens including cache reads. These ceilings allowed parent review to finish; the earlier attempts keep their original limits and scores.

| Check | Normal workers | Communication enabled |
| --- | --- | --- |
| Frozen public tests | 53/53 | 53/53 |
| Types / scoped style | Pass / Pass | Pass / Pass |
| Separate refresh regression | Pass | Pass |
| Worker-authored tests | 4/4 | None added |
| Out-of-scope changes | None | None |
| Parent finished | Yes | Yes |
| Worker outcomes | Two completed; one hit its token limit | All three completed |
| Messages / board body returns | 0 / 0 | 0 / 0 |
| Recorded input, including cache | 2,893,255 | 1,630,076 |
| Output tokens | 38,230 | 20,463 |
| Elapsed seconds | 485.2 | 297.8 |

Normal mode's parent repaired SSE fallback and connection-timeout cleanup after its implementation worker exhausted its 20,000-token output budget. The communication parent repaired an OAuth configuration union-type error after collecting its workers. Both parents ran the final checks, and separate grading reproduced their passing results.

The communication-enabled attempt consumed fewer tokens and finished sooner in this pair. It did not exchange messages or read the board, so those differences cannot be attributed to an exchange. Concurrent execution and one attempt per mode also prevent a reliable speed estimate. Types and formatting checks provide no measured readability advantage, and generated-code performance was not benchmarked.

Capture: `/private/tmp/kimchi-compaction-arms-02e345fm`. All 20 isolation/toolchain checks passed. The 1,756 sealed inputs matched after execution; model IDs, channel masks and usage totals were verified. Both TMUX sessions stopped and copied credential homes were removed.

## Initial six attempts

| Attempt | Public checks / 53 | Types | Style | Separate refresh check | End state |
| --- | ---: | --- | --- | --- | --- |
| Solo 1 | 53 | Pass | Pass | Pass | Time limit; local-test approval interrupted work |
| Normal workers 1 | 52 | Pass | Fail | Pass | Token limit; one out-of-scope edit |
| Communication 1 | 53 | Pass | Pass | **Fail** | Token limit; all three workers finished |
| Communication 2 | 53 | Pass | Pass | Pass | **Invalid team comparison:** zero workers; solo fallback |
| Normal workers 2 | 53 initially; 52 on recheck | **Fail** | Pass | Pass | Token limit; added test does not typecheck |
| Solo 2 | 53 | Pass | Pass | Pass | Completed |

Normal workers 2 had one intermittent callback-test failure during regrading. Three subsequent callback-suite runs passed 7/7, as did three reference runs. The failing assertion concerned browser-open errors, not the requested port-selection change. Its cause remains unresolved; it does not support a communication claim. The added test's TypeScript errors reproduced independently.

## What was compared

The task reconstructs three buggy production modules from the parent of `dcc26382`, within current source and installed dependencies. It repairs occupied callback ports, non-interactive probing and duplicate HTTP connections that consume rotating refresh tokens. Both probe and persistent connections must preserve authorization handling and SSE fallback.

The frozen public suite contains 53 checks, including four added connection-count regressions. Before inference, the broken source passed 47/53 and the reference passed 53/53; both passed types and scoped style. Every arm could read the same source, dependencies and public tests. Three team workers owned separate modules; shared files and parent steering remained available in normal mode. Communication was optional, with no posting quota.

Each attempt used the same built binary, `kimchi-dev/glm-5.3-flash`, disabled Ferment, and limits of 600 seconds, 30,000 output tokens and 2,000,000 total recorded tokens including cache reads. The second batch reversed launch order. Native phase handling changed Solo 1 from low to medium thinking; the other sessions stayed low. These are small, budget-limited samples of one task, not a general ranking.

## What the code review found

The communication lifecycle worker replaced `getValidToken`'s SDK connection path with direct metadata discovery against the MCP resource URL. When the authorization server has a different origin, the new code requests a token from the resource server instead. It returns no refreshed token.

The [supplemental regression](../../scripts/agent-communication/oauth-refresh.diff) exercises the real installed MCP SDK with deterministic HTTP responses. Both historical versions, both normal outputs and both solo outputs pass; Communication 1 fails. This check was added after reviewing the first outputs and stays separate from the frozen score. The worker's board finding described the refresh rewrite as verified, but its cited callback tests did not cover this behavior.

Communication 1 returned two peer board entries to a worker and sent no directed messages. The read preceded later edits, but those edits continued its existing transport-repair plan. The trace does not establish that the finding caused the public-test success. No parent production edits occurred in the valid team attempts before their budgets ended.

Normal workers 1 missed the dynamic-port fix, added an unnecessary exported refresh helper, and changed the protected `types.ts` file. Normal workers 2 repaired the production behavior but added a test that accesses `server.address().port` without narrowing its nullable union type. Runtime tests passed; typechecking caught the defect. Both solo outputs kept the refresh helper unchanged. Formatting checks do not establish a readability or performance advantage for communication.

## Resource use and limits

| Attempt | Uncached input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Solo 1 | 296,024 | 907,392 | 25,997 |
| Normal workers 1 | 206,470 | 1,788,352 | 22,545 |
| Communication 1 | 388,715 | 1,593,344 | 27,224 |
| Communication 2, solo fallback | 271,017 | 1,039,360 | 22,585 |
| Normal workers 2 | 130,008 | 1,860,672 | 22,100 |
| Solo 2 | 204,787 | 1,397,504 | 13,426 |

Counts include parent and worker inference. Response-boundary monitoring permits a small budget overshoot. The failed staffing attempt, approval interruption, thinking change and concurrent execution prevent a clean speed comparison. There is no demonstrated inference saving here.

Initial grading restored every protected file, including Normal workers 1's production type edit. That invented a type error. Corrected grading preserves production bytes, restores only grading inputs, and reports scope violations separately. Both grading attempts remain in the capture. Missing host `.kimchi/tags.json` was also removed from the violation count because snapshots deliberately exclude host state.

All six sessions stopped and copied credential homes were removed. The 56 isolation/toolchain checks passed; saved model IDs, channel masks, source hashes and token totals were verified. Capture: `/private/tmp/kimchi-compaction-arms-sfcev413`; frozen scripts are under `frozen-protocol/`. Reproduction commands are in the [runner README](../../scripts/agent-communication/README.md#oauth-repair-comparison).

## Launch recovery and four repeats

The failed launch in the initial cohort exposed an ambiguous experiment error: its JSON showed required arguments without distinguishing them from submitted arguments. The parent kept removing fields. The experiment guard now reports each expected and received value, states that no worker started, and asks for a corrected retry. Eligibility and budgets are unchanged.

A unit regression failed with the old text and passed with the correction. In an isolated native TMUX probe, the parent corrected two deliberately rejected launches on its first retry; both workers completed their files. Four guard tests, nine runner tests and `pnpm run check` passed, with one existing unused-import warning. This proves recovery in that probe, not a coding-quality improvement.

Four fresh attempts then used the original 600-second / 30,000-output / 2,000,000-total ceilings, in normal–communication–communication–normal order. Every attempt launched three workers. Communication repeat 2 corrected three rejected launches on its first retry. All four parents were stopped by the global token ceiling before final review; the table describes partial artifacts.

| Partial artifact | Public / 53 | Types | Style | Separate refresh | Added tests execute |
| --- | ---: | --- | --- | --- | --- |
| Normal repeat 1 | 53 | Fail | Fail | Fail | Fail |
| Communication repeat 1 | 53 | Fail | Pass | Pass | Fail |
| Communication repeat 2 | 53 | Pass | Pass | Pass | Pass |
| Normal repeat 2 | 51 | Fail | Fail | Pass | Pass |

Normal repeat 1 contains duplicate `skipAuth` fields in protected `types.ts`. The saved tool calls show that two different workers added the same field. This is a concrete failure to combine work coherently, despite their assigned ownership. Communication repeat 1 instead contains errors in new tests: a `Promise.all` tuple destructured as an object and a missing `afterEach` import.

Communication repeat 2 returned 11 board bodies, including nine returns of peer entries, and sent no directed messages. One posted finding incorrectly described synchronous auth helpers as promises; its passing tests did not verify that assertion. The output passed the external checks, but the trace does not establish a useful change caused by that finding. The other three attempts had no messages or board body returns.

Capture: `/private/tmp/kimchi-compaction-arms-ft16bpi0`; recovery probe: `/private/tmp/kimchi-launch-recovery-i9v_21x6`. All 38 isolation/toolchain checks and 1,768 sealed-input comparisons passed. All sessions stopped and copied credential homes were removed. Normal repeat 2 recorded one more response during shutdown than the monitor's stop sample; the results retain both counts and use the complete saved trace for resource use.

The shared-file collision does not justify adding another scheduler. Pi 0.84.1 already serializes same-file edit operations through `withFileMutationQueue`; that cannot prevent two individually valid edits from adding the same declaration. [Pi Messenger](https://github.com/nicobailon/pi-messenger#features) also offers file reservations through existing extension hooks. Neither mechanism was tested as a remedy here.
