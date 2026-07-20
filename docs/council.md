# Kimchi Council

`kimchi/council` is a normal Kimchi model backed by a bounded, in-process Council workflow. It is a hackathon implementation: no proxy changes or deployment are required.

## Architecture and ownership

```text
Kimchi CLI / TUI / print / ACP
          |
          v
Pi custom provider: kimchi/council
          |
          v
lead -> reviewers (parallel) -> judge -> one revision
  |              |                |           |
  +--------------+----------------+-----------+
                 physical models from ModelRegistry
```

Kimchi owns Council orchestration, limits, task-packet construction, structured review parsing, fallback behavior, usage aggregation, and the public response. Pi's `ModelRegistry` owns physical model lookup and credentials. The existing provider implementations still own physical requests. This follows Pi's [custom-provider extension](https://pi.dev/docs/latest/custom-provider) mechanism instead of adding another transport.

Internal reviewer and judge responses are not replayed or persisted. The public message is attributed to `kimchi/council`.

## Configuration

Built-in defaults:

| Setting | Default |
| --- | --- |
| Lead | `kimchi-dev/kimi-k2.7` |
| Reviewers | `kimchi-dev/glm-5.2-fp8`, `kimchi-dev/deepseek-v4-flash`, `kimchi-dev/kimi-k2.7` |
| Judge | `kimchi-dev/deepseek-v4-flash` |
| Stage timeout | 300 seconds |
| Overall timeout | 1,200 seconds |
| Lead/revision output | 32,768 tokens each |
| Reviewer/judge output | 8,192 tokens each |
| Physical calls | 7 maximum |
| Parallel reviewers | 3 maximum |
| Evidence packet | 128 KiB maximum |
| Structured reviewer/judge result | 32 KiB maximum |

Environment overrides:

| Variable | Meaning |
| --- | --- |
| `KIMCHI_COUNCIL_ENABLED` | `true` or `false`; defaults to enabled. |
| `KIMCHI_COUNCIL_LEAD_MODEL` | Physical `provider/model` used for lead and revision. |
| `KIMCHI_COUNCIL_REVIEWER_MODELS` | Comma-separated physical reviewer references; two or three are required and the first three are used. |
| `KIMCHI_COUNCIL_JUDGE_MODEL` | Physical judge model reference. |
| `KIMCHI_COUNCIL_TIMEOUT_MS` | Whole-run timeout in milliseconds; default and hard maximum `1200000`. |
| `KIMCHI_COUNCIL_STAGE_TIMEOUT_MS` | Per-stage timeout in milliseconds; default and hard maximum `300000`. |
| `KIMCHI_COUNCIL_MAX_PARALLEL_REVIEWERS` | Maximum concurrent reviewers; default `3`. |
| `KIMCHI_COUNCIL_LEAD_MAX_TOKENS` | Lead and revision output budget; default and hard maximum `32768`. |
| `KIMCHI_COUNCIL_INTERNAL_MAX_TOKENS` | Reviewer and judge output budget; default and hard maximum `8192`. |
| `KIMCHI_COUNCIL_MAX_EVIDENCE_BYTES` | Text evidence packet limit; default and hard maximum `131072`. |
| `KIMCHI_COUNCIL_MAX_STRUCTURED_BYTES` | Per-review or judge JSON limit; default and hard maximum `32768`. |
| `KIMCHI_COUNCIL_MAX_CALLS` | Whole-run physical call cap; default `7`. |

Numeric values must be positive integers; invalid values fall back to the defaults. Physical references must resolve through the normal model registry and may not point back to `kimchi/council`.

## Use

Select Council anywhere a regular model reference is accepted:

```bash
export KIMCHI_COUNCIL_ENABLED=true
kimchi --model kimchi/council
kimchi --print --model kimchi/council "Review this repository and fix the failing test"
```

Other models remain registered and selectable. Council is not a second multi-model mode: existing `multi-model` behavior is unchanged, and choosing `kimchi/council` only changes the selected model for that run.

Run the focused test:

```bash
pnpm exec vitest run src/extensions/council
```

## Terminal Bench comparison

From the repository root, run the same task and attempt count for Council and its lead baseline:

```bash
cd benchmark/terminal-bench-2
MODEL='kimchi/council' ./scripts/run-local.sh -i terminal-bench/fix-git -n 1 -k 1
MODEL='kimchi-dev/kimi-k2.7' ./scripts/run-local.sh -i terminal-bench/fix-git -n 1 -k 1
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
- Each request is one bounded round: lead, up to three reviewers, judge, then at most one revision.
- Council advertises text input, matching the proxy prototype. Reviewers receive a bounded text evidence packet; the lead still sees the original tools and conversation.
- Raw reviewer, judge, and chain-of-thought content is not persisted or returned.
- The virtual model advertises zero USD rates; it is not a pricing contract for the physical calls.
- Child calls use `ModelRegistry` authentication and preserve retry settings and request/response callbacks. Virtual-provider headers and environment values are not forwarded, and Pi's physical-model-specific attribution merge and `before_provider_headers` hook are not rerun.
- Catalog metadata does not prove that every physical model is equally reliable at tool calls or structured JSON.
- This work does not deploy Council or change the proxy.

A production version should move orchestration behind a thin first-class Council API while preserving `kimchi/council` as the harness-facing model contract.
