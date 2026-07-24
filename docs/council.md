# Kimchi Council

Kimchi Council exposes bounded fast, normal, and deep models backed by one in-process workflow. It is a hackathon implementation: no proxy changes or deployment are required.

## Architecture and ownership

```text
Kimchi CLI / TUI / print / ACP
          |
          v
Pi custom provider: kimchi/council
          |
          v
lead -> read / stage edit, write, delete, or rename in a ChangeTransaction
          | no candidate                    | cumulative candidate
          v                                 v
     text review policy       compile exact patch + base evidence
                                           |
                                           v
                          independent / critic / checker (parallel)
                                           |
                                           v
                          judge -> optional one revision + focused checker
                                           |
                                           v
                    permissioned exact apply -> required checks -> finalize
                                                        |
                                                        +-> rollback on failure
```

Kimchi owns Council orchestration, the generic in-memory change transaction, cumulative run budgets, typed evidence compilation, strict role schemas, fallback behavior, usage aggregation, and the public response. Pi's `ModelRegistry` owns physical model lookup and credentials. Existing provider implementations still own physical requests. This follows Pi's [custom-provider extension](https://pi.dev/docs/latest/custom-provider) mechanism instead of adding another transport.

Internal reviewer and judge responses are not replayed or persisted. The public message is attributed to the selected Council model.

For code changes, `read` sees the transaction overlay while `edit`, `write`, `council_delete_file`, and `council_rename_file` change only that overlay. The real workspace is untouched until the cumulative patch has been reviewed and accepted. Independent review sees a compact current-turn base-evidence packet without the lead draft or candidate. Critic and checker see the exact candidate patch, its hash, and only relevant validation evidence. Role packets retain bounded `Guidelines`, `Factual Accuracy`, `Project Guidelines`, and explicit `Council Constraints` sections while omitting tool schemas, environment metadata, and orchestration instructions. Unknown mutation tools and mutating shell commands are blocked while a transaction is open. Council does not use Git worktrees as its runtime isolation mechanism.

The accepted patch is applied through the normal permission path with a one-use, server-side capability tied to transaction ID and patch hash. Base bytes and modes are verified immediately before apply. The judge routes upheld source defects to revision and catalog-backed `needs_evidence` findings to post-apply validation; raw reviewer metadata cannot bypass that adjudication. The judge selects stable IDs from a deterministic, repository-derived catalog of safe validation checks and cannot supply shell commands. Rollback data remains available until every selected check runs through its exact catalog command and settlement completes. A failed check, denied settlement, cancellation, or safe cleanup path rolls the patch back. After successful settlement, Council returns the stored reviewed response without another unreviewed model call.

Exact compact packets and schema-valid structured results are cached for the lifetime of one transaction. Cache keys include the patch, base snapshot, objective, constraints, evidence, role, model, prompt version, and schema version. The cache is bounded, isolated by packet/result namespace, and never stores raw reasoning or schema-invalid output.

Each Council stream stores one sanitized `council_run` record with wall-clock duration, terminal outcome, degraded reason, agreement, unresolved-finding count, missing reviewer roles, per-attempt truncation/retry/fallback/cache status, cache hit/miss counts, aggregate usage/cost, cumulative logical/physical/concurrency/token/evidence budgets, and safe transaction state. Budgets and one absolute deadline persist across the tool rounds of the same user turn.

## Presets

Preset choice is explicit; Council does not guess task complexity. Use fast for small or time-sensitive work, normal for routine engineering, and deep for complex or high-risk work.

| Model | Review path | Revision | Logical/physical cap | Lead/internal tokens | Evidence/result | Stage/overall timeout |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `kimchi/council-fast` | critic; judge required for code candidates | on issues | 12 / 14 | 12,288 / 4,096 | 128 / 8 KiB | 30 / 90 seconds |
| `kimchi/council` | independent + critic + checker; judge | on upheld source issues after judging | 16 / 20 | 24,576 / 16,384 | 128 / 128 KiB | 160 / 420 seconds |
| `kimchi/council-deep` | independent + critic + checker; judge | always | 16 / 20 | 32,768 / 16,384 | 128 / 128 KiB | 160 / 420 seconds |

Normal and deep review text-only answers as well as code candidates. Fast skips its critic for direct/read-only text turns, but any nontrivial staged code candidate still receives critic review and judge adjudication before promotion.

The call caps cover lead tool work, review, one revision, focused checking, and bounded repairs. Council stops advertising lead tools when the remaining call slots are needed for review and verification. Pool fallbacks still consume the bounded physical-attempt budget and may fail closed when no headroom remains.

Structured stages have smaller independent output ceilings: independent 2,500 tokens, critic 4,000, checker 8,000, judge 8,000, and repair 8,000. A malformed stage can be repaired once, with at most two repairs in the whole run; those counters persist across transaction tool rounds.

## Configuration

Deep ceilings and physical model defaults:

| Setting | Default |
| --- | --- |
| Lead | `kimchi-dev/kimi-k2.7` |
| Reviewers | critic: `kimchi-dev/deepseek-v4-flash`; checker: `kimchi-dev/minimax-m3`; independent: `kimchi-dev/glm-5.2-fp8` |
| Judge | `kimchi-dev/deepseek-v4-flash` |
| Stage timeout | 160 seconds |
| Overall timeout | 420 seconds |
| Lead/revision output | 32,768 tokens each |
| Reviewer/judge output | 16,384 tokens each |
| Physical reasoning (capable models) | role-specific: reviewer `low`/`medium`, judge `high`, revision `low` |
| Logical calls / physical attempts | 16 / 20 maximum |
| Parallel reviewers | 3 maximum |
| Evidence packet | 128 KiB maximum |
| Aggregate structured output | 128 KiB maximum |
| Aggregate input/output tokens | 786,432 / 98,304 maximum |
| Estimated physical cost | USD 25 maximum |

Environment overrides:

| Variable | Meaning |
| --- | --- |
| `KIMCHI_COUNCIL_ENABLED` | `true` or `false`; defaults to enabled. Set to `false` to hide Council models. |
| `KIMCHI_COUNCIL_LEAD_MODEL` | Physical `provider/model` used for lead and revision. |
| `KIMCHI_COUNCIL_LEAD_FALLBACK_MODELS` | Comma-separated lead/revision fallbacks. |
| `KIMCHI_COUNCIL_INDEPENDENT_MODEL`, `KIMCHI_COUNCIL_CRITIC_MODEL`, `KIMCHI_COUNCIL_CHECKER_MODEL` | Named reviewer primaries. |
| `KIMCHI_COUNCIL_INDEPENDENT_FALLBACK_MODELS`, `KIMCHI_COUNCIL_CRITIC_FALLBACK_MODELS`, `KIMCHI_COUNCIL_CHECKER_FALLBACK_MODELS` | Per-role comma-separated fallbacks. |
| `KIMCHI_COUNCIL_REVIEWER_MODELS` | Deprecated compatibility mapping: independent, critic, then optional checker primary. |
| `KIMCHI_COUNCIL_JUDGE_MODEL` | Physical model used for the judge. |
| `KIMCHI_COUNCIL_JUDGE_FALLBACK_MODELS` | Comma-separated judge fallbacks. |
| `KIMCHI_COUNCIL_TIMEOUT_MS` | Whole-turn timeout in milliseconds; default and hard maximum `420000`. |
| `KIMCHI_COUNCIL_STAGE_TIMEOUT_MS` | Per-stage timeout in milliseconds; default and hard maximum `160000`. |
| `KIMCHI_COUNCIL_MAX_PARALLEL_REVIEWERS` | Maximum concurrent reviewers; default `3`. |
| `KIMCHI_COUNCIL_LEAD_MAX_TOKENS` | Lead and revision output budget; default and hard maximum `32768`. |
| `KIMCHI_COUNCIL_INTERNAL_MAX_TOKENS` | Reviewer and judge output budget; default and hard maximum `16384`. |
| `KIMCHI_COUNCIL_MAX_EVIDENCE_BYTES` | Text evidence packet limit; default and hard maximum `131072`. |
| `KIMCHI_COUNCIL_MAX_STRUCTURED_BYTES` | Aggregate structured-output limit; default and hard maximum `131072`. |
| `KIMCHI_COUNCIL_MAX_LOGICAL_CALLS` | Whole-turn logical call cap; default `16` (`KIMCHI_COUNCIL_MAX_CALLS` remains an alias). |
| `KIMCHI_COUNCIL_MAX_PHYSICAL_ATTEMPTS` | Whole-turn physical attempt cap; default `20`. |
| `KIMCHI_COUNCIL_MAX_CONCURRENT_CALLS` | Whole-run concurrent physical-call cap; default `3`. |
| `KIMCHI_COUNCIL_MAX_AGGREGATE_INPUT_TOKENS` | Aggregate physical input-token cap; default `786432`. |
| `KIMCHI_COUNCIL_MAX_AGGREGATE_OUTPUT_TOKENS` | Aggregate physical output-token cap; default `98304`. |
| `KIMCHI_COUNCIL_MAX_ESTIMATED_COST_USD` | Pre-dispatch estimated physical-cost cap; default `25`. |
| `KIMCHI_COUNCIL_MAX_RETRIES_PER_CALL` | Invoker-owned retries before a pool fallback; default `0`. |

Numeric limits must be positive (integer except for the USD cap); invalid values fall back to the defaults. Environment values form the deep ceiling; fast and normal apply their lower preset caps after overrides. Physical references must resolve through the normal model registry and may not point back to a Council virtual model.

Council reserves budgets before dispatch and reconciles them from returned usage. Provider-library retries are forced to zero; the counted Council invoker owns retries and pool fallback. Cost estimation and the USD cap are effective only when the physical model registry supplies non-zero pricing; the current Kimchi proxy catalog reports zero prices, so cost remains zero and the cap cannot be enforced for those models.

Malformed structured output is repaired through the same role pool, including the judge pool for judge output. Repair is capped at 8,000 tokens, once per source stage and twice per run.

Validation models receive only check IDs, kind, working directory, allowlisted executable, timeout, and mutation policy; exact arguments stay inside the runtime. Sanitized run telemetry records a SHA-256 command fingerprint instead of the command text.

## Use

Select Council anywhere a regular model reference is accepted:

```bash
kimchi --model kimchi/council-fast
kimchi --model kimchi/council
kimchi --model kimchi/council-deep
kimchi --print --model kimchi/council "Review this repository and fix the failing test"
```

Other models remain registered and selectable. Council is not a second multi-model mode: existing `multi-model` behavior is unchanged, and choosing a Council preset only changes the selected model for that run.

Run the focused test:

```bash
pnpm exec vitest run src/extensions/council
```

## Terminal Bench comparison

From the repository root, run the same task and attempt count for each preset and its lead baseline:

```bash
cd benchmark/terminal-bench-2
MODEL='kimchi/council-fast' ./scripts/run-local.sh -i terminal-bench/fix-git -n 1 -k 1
MODEL='kimchi/council' ./scripts/run-local.sh -i terminal-bench/fix-git -n 1 -k 1
MODEL='kimchi/council-deep' ./scripts/run-local.sh -i terminal-bench/fix-git -n 1 -k 1
MODEL='kimchi-dev/kimi-k2.7' ./scripts/run-local.sh -i terminal-bench/fix-git -n 1 -k 1
MODEL='kimchi-dev/glm-5.2-fp8' ./scripts/run-local.sh -i terminal-bench/fix-git -n 1 -k 1
```

`run-local.sh` automatically forwards `KIMCHI_API_KEY` and enables Council when `MODEL` starts with `kimchi/council`. Non-default `KIMCHI_COUNCIL_*` values must still be forwarded explicitly to Harbor, for example:

```bash
MODEL='kimchi/council' ./scripts/run-local.sh \
  -i terminal-bench/fix-git -n 1 -k 1 \
  --ae 'KIMCHI_COUNCIL_MAX_PARALLEL_REVIEWERS=2' \
  --ae 'KIMCHI_COUNCIL_TIMEOUT_MS=30000'
```

## Hackathon boundaries

- Responses are buffered until Council completes; the TUI shows fixed, non-sensitive validating/drafting/reviewing/judging/revising/finalizing progress labels.
- Coordination and limits are process-local.
- One user turn is one bounded cumulative transaction, even when tool execution requires several model streams. Fast omits the judge only for text-only responses; every code candidate is adjudicated. Normal may omit revision; deep always requests it.
- A stopped lead with no public answer or tool call is retried once inside the same bounded round; hidden reasoning is never promoted to the answer.
- Council advertises text input. Reviewers receive bounded typed artifacts for system/user/assistant/tool-call/tool-result evidence. Independent review omits the lead draft, candidate mutation calls, staged results, and post-mutation overlay reads; it retains only base evidence gathered before the first staged mutation in the current user turn. The checker must return every supplied stable requirement ID exactly once; missing, duplicate, or unknown IDs are rejected. Every physical attempt fits its context and output cap to the selected model. The virtual model's picker limits are static because provider registration happens before the session `ModelRegistry` is available; runtime fitting remains authoritative for custom physical models with smaller limits.
- Evidence strings are redacted fail-closed and remain data, never reviewer/judge instructions. Stable requirement and constraint IDs let reviewers and the judge cite the same facts without replaying the transcript. Revision receives one compact packet containing the objective, exact candidate, cited evidence, strict dispositions, and required corrections.
- If only some reviewers produce usable structured results, their missing roles are passed to the judge as evidence gaps and force revision; they never count as acceptance votes.
- Raw reviewer, judge, and chain-of-thought content is not persisted or returned.
- A code candidate fails closed if context compilation, a required reviewer, adjudication, final evidence checking, exact apply, or settlement fails. Text-only fast responses may still return the lead as degraded when its reviewer is unavailable.
- Findings receive stable IDs. A judge must disposition every finding exactly once as `resolved`, `upheld`, or `needs_evidence`; resolved findings require cited evidence, upheld findings require source revision, and each evidence gap must name a selected deterministic validation ID. A failed selected check rolls the candidate back instead of asking the lead to revise missing runtime evidence.
- A transaction permits one full panel review, at most one lead revision, and one focused final checker. A resolved final-check obligation must cite evidence from the exact revised candidate context.
- Post-apply validation accepts only narrow, non-mutating test, typecheck, lint, or build commands discovered from package, repository, and configuration metadata. Judge-required checks are catalog IDs; the runtime resolves and executes their exact argument arrays, and all selected checks must succeed before finalization. Validation is refused after the absolute whole-run deadline, and each emitted command timeout is clamped to the remaining deadline.
- Supported candidate mutations are UTF-8 file create/update/delete/rename operations. Traversal, symbolic-link paths, case or physical path aliases, directories, binary content, concurrent base drift, and unsupported mutation tools fail closed. Apply revalidates moved base bytes and installs new content without replacing a concurrently created path.
- The virtual model advertises zero USD rates; it is not a pricing contract for the physical calls.
- Child calls use `ModelRegistry` lookup/auth, preserve request/response callbacks and safe session headers, and attach explicit virtual/run/stage/physical metadata. Virtual-provider auth, arbitrary headers, and environment values are not forwarded. The pinned Pi SDK exposes no bound normal-invocation seam, so its private attribution merge and `before_provider_headers` hook cannot be rerun; provider retries are disabled and counted locally.
- Catalog metadata does not prove that every physical model is equally reliable at tool calls or structured JSON.
- This work does not deploy Council or change the proxy.

A production version should move orchestration behind a thin first-class Council API while preserving `kimchi/council` as the harness-facing model contract.
