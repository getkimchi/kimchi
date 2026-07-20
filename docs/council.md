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
lead -> reviewers (parallel) -> optional judge -> optional revision
  |              |                         |                   |
  +--------------+-------------------------+-------------------+
                 physical models from ModelRegistry
```

Kimchi owns Council orchestration, limits, task-packet construction, structured review parsing, fallback behavior, usage aggregation, and the public response. Pi's `ModelRegistry` owns physical model lookup and credentials. The existing provider implementations still own physical requests. This follows Pi's [custom-provider extension](https://pi.dev/docs/latest/custom-provider) mechanism instead of adding another transport.

Internal reviewer and judge responses are not replayed or persisted. The public message is attributed to the selected Council model.

## Presets

Preset choice is explicit; Council does not guess task complexity. Use fast for small or time-sensitive work, normal for routine engineering, and deep for complex or high-risk work.

| Model | Review path | Revision | Call cap | Lead/internal tokens | Evidence/result | Stage/overall timeout |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `kimchi/council-fast` | critic only; no judge | on critic issues | 5 | 8,192 / 2,048 | 32 / 8 KiB | 60 / 240 seconds |
| `kimchi/council` | critic + checker; judge | on reviewer or judge issues | 7 | 16,384 / 4,096 | 64 / 16 KiB | 180 / 720 seconds |
| `kimchi/council-deep` | critic + checker + independent; judge | always | 8 | 32,768 / 8,192 | 128 / 32 KiB | 300 / 1,200 seconds |

## Configuration

Deep ceilings and physical model defaults:

| Setting | Default |
| --- | --- |
| Lead | `kimchi-dev/kimi-k2.7` |
| Reviewers | critic: `kimchi-dev/deepseek-v4-flash`; checker: `kimchi-dev/minimax-m3`; independent: `kimchi-dev/glm-5.2-fp8` |
| Judge | `kimchi-dev/deepseek-v4-flash` |
| Stage timeout | 300 seconds |
| Overall timeout | 1,200 seconds |
| Lead/revision output | 32,768 tokens each |
| Reviewer/judge output | 8,192 tokens each |
| Physical reasoning (capable models) | `medium` |
| Physical calls | 8 maximum |
| Parallel reviewers | 3 maximum |
| Evidence packet | 128 KiB maximum |
| Structured reviewer/judge result | 32 KiB maximum |

Environment overrides:

| Variable | Meaning |
| --- | --- |
| `KIMCHI_COUNCIL_ENABLED` | `true` or `false`; defaults to enabled. |
| `KIMCHI_COUNCIL_LEAD_MODEL` | Physical `provider/model` used for lead and revision. |
| `KIMCHI_COUNCIL_REVIEWER_MODELS` | Comma-separated independent, critic, then checker model references; two or three are required and the first three are used. With two models, Council reuses one under the missing role prompt so every preset keeps its documented review roles. |
| `KIMCHI_COUNCIL_JUDGE_MODEL` | Physical model used for the judge. |
| `KIMCHI_COUNCIL_TIMEOUT_MS` | Whole-run timeout in milliseconds; default and hard maximum `1200000`. |
| `KIMCHI_COUNCIL_STAGE_TIMEOUT_MS` | Per-stage timeout in milliseconds; default and hard maximum `300000`. |
| `KIMCHI_COUNCIL_MAX_PARALLEL_REVIEWERS` | Maximum concurrent reviewers; default `3`. |
| `KIMCHI_COUNCIL_LEAD_MAX_TOKENS` | Lead and revision output budget; default and hard maximum `32768`. |
| `KIMCHI_COUNCIL_INTERNAL_MAX_TOKENS` | Reviewer and judge output budget; default and hard maximum `8192`. |
| `KIMCHI_COUNCIL_MAX_EVIDENCE_BYTES` | Text evidence packet limit; default and hard maximum `131072`. |
| `KIMCHI_COUNCIL_MAX_STRUCTURED_BYTES` | Per-review or judge JSON limit; default and hard maximum `32768`. |
| `KIMCHI_COUNCIL_MAX_CALLS` | Whole-run physical call cap; default `8`. |

Numeric values must be positive integers; invalid values fall back to the defaults. Environment values form the deep ceiling; fast and normal apply their lower preset caps after overrides. Physical references must resolve through the normal model registry and may not point back to a Council virtual model.

## Use

Select Council anywhere a regular model reference is accepted:

```bash
export KIMCHI_COUNCIL_ENABLED=true
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

The built-in Council defaults need no extra environment forwarding. `run-local.sh` forwards `KIMCHI_API_KEY`; non-default `KIMCHI_COUNCIL_*` values must be forwarded explicitly to Harbor, for example:

```bash
MODEL='kimchi/council' ./scripts/run-local.sh \
  -i terminal-bench/fix-git -n 1 -k 1 \
  --ae 'KIMCHI_COUNCIL_MAX_PARALLEL_REVIEWERS=2' \
  --ae 'KIMCHI_COUNCIL_TIMEOUT_MS=30000'
```

## Hackathon boundaries

- Responses are buffered until Council completes; the TUI gets no per-stage progress.
- Coordination and limits are process-local.
- Each request is one bounded round. Fast omits the judge; normal may omit revision; deep runs the full lead, three-reviewer, judge, and revision path.
- A stopped lead with no public answer or tool call is retried once inside the same bounded round; hidden reasoning is never promoted to the answer.
- Council advertises text input, matching the proxy prototype. Reviewers receive a bounded text evidence packet; the lead still sees the original tools and conversation.
- Reviewer packets and revision history exclude transient injected messages that lack the conversation timestamp required by Pi; the lead still receives them as operational guidance.
- Raw reviewer, judge, and chain-of-thought content is not persisted or returned.
- A reviewer critical remains authoritative unless a successful judge returns a resolved, high-impact disagreement whose topic exactly matches the finding statement and whose resolution is nonempty. Judge criticals remain authoritative. If a critical remains and revision fails, Council returns an error instead of the flagged lead draft.
- The virtual model advertises zero USD rates; it is not a pricing contract for the physical calls.
- Child calls use `ModelRegistry` authentication and preserve retry settings and request/response callbacks. Virtual-provider headers and environment values are not forwarded, and Pi's physical-model-specific attribution merge and `before_provider_headers` hook are not rerun.
- Catalog metadata does not prove that every physical model is equally reliable at tool calls or structured JSON.
- This work does not deploy Council or change the proxy.

A production version should move orchestration behind a thin first-class Council API while preserving `kimchi/council` as the harness-facing model contract.
