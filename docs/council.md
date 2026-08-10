# Kimchi Council

Council answers a turn by having several models solve the same task independently, comparing their
solutions, and writing a final patch or answer from that comparison. It is exposed as three ordinary models —
`kimchi/council-fast`, `kimchi/council`, `kimchi/council-deep` — selectable anywhere a model
reference is accepted.

The pipeline and its rationale are described in [council-fusion-design.md](council-fusion-design.md).

## Pipeline

```text
Kimchi CLI / TUI / print / ACP
          |
          v
Pi custom provider: kimchi/council
          |
          v
lead explores the repo with read tools, then answers: a code change, or text
          |
          +---------------------------+---------------------------------+
          | code change                                text answer      |
          v                                                    v
   (staged; triage below                            trivial/short answer?
    decides trivial vs reviewed)                             | yes
          |                                                   v
          |                                     lead answers directly, streamed
          |                                                   | no (substantial)
          v                                                   v
   freeze context: files read this turn + objective + constraints  (same compiler, either branch)
          |                                                   |
          v                                                   v
   panel: N solvers in parallel, identical context, none sees the others
      lead's own patch/answer + solver 2 + solver 3 ...
          |                                                   |
          v                                                   v
   analyst: consensus / contradictions / partial coverage / unique insights / blind spots
          |                                                   |
          v                                                   v
   synthesis: lead writes the final patch          synthesis: lead writes the final answer
          |                                                   |
          v                                                   v
   stage -> apply -> catalog checks -> settle       synthesized answer returned, buffered
                  |                                 (no transaction opens)
                  +-> rollback on failure
```

Text deliberation reuses the same panel/analyst/synthesis machinery as a code change, minus the
transaction: no `ChangeTransaction` opens, no diff is rendered, and no validation check ever runs.
Any comparison-layer failure on either branch — panel, analyst, synthesis, deadline, or budget —
falls back to the lead's own patch or answer instead of losing the turn.

Kimchi owns orchestration, the in-memory change transaction, run budgets, evidence compilation,
stage schemas, and the public response. Pi's `ModelRegistry` owns physical model lookup and
credentials, and existing provider implementations own physical requests. This uses Pi's
[custom-provider extension](https://pi.dev/docs/latest/custom-provider) rather than adding another
transport.

Solver, analyst, and synthesis output is structured, schema-validated, repairable once, and never
replayed, persisted, or shown. The public message is attributed to the selected Council model.

## How a code change is made

The lead stages edits in an in-memory overlay: `read` sees the overlay while `edit`, `write`,
`council_delete_file`, and `council_rename_file` change only the overlay. The real workspace is
untouched until synthesis produces a patch that passes apply-time base verification. Unknown
mutation tools and mutating shell commands are blocked while a transaction is open.

Once anything is staged, `bash` is withdrawn and `council_check_candidate` takes its place: the lead
may run one check from the same deterministic catalog the analyst draws `required_checks` from, named
by id only, never by a model-supplied command. The runtime resolves the id to its exact argument
vector and runs it against the staged candidate — sourced from the live `ChangeTransaction` overlay,
not re-derived from model output — inside an isolated temporary workspace: the project's own tracked
files copied in, `node_modules` and `.git` linked rather than copied, and the candidate's own
create/update/delete/rename operations written on top. The real workspace is only ever read; the
temporary workspace is removed afterward regardless of outcome, including on failure and abort. The
check's output returns as an ordinary tool result so the lead can fix and re-stage before finishing.
Calls are capped at three per turn and draw on the same whole-run deadline as everything else; the
tool is only advertised while a transaction has staged changes, and post-apply checks still gate
promotion exactly as before.

Every panel member receives the identical frozen packet — objective, constraints, file contents,
command output — with fail-closed redaction and byte bounds applied. Solvers have no tools and
cannot observe each other. Each emits a complete patch: a list of create, update, delete, and rename
operations carrying full file content. Diffs are computed by the runtime from real base bytes;
a model never authors a diff that another stage reads.

The analyst receives those diffs anonymously, in hash-seeded shuffled order, and compares them. It
cannot emit code. Synthesis runs on the lead pool, so final authorship stays with the model holding
the session, and its patch is staged as the single transaction candidate.

The accepted patch is applied through the normal permission path; the internal apply and settle
tools authenticate by transaction ID and patch hash, which `ChangeTransaction` verifies and enforces
as a single-use state transition. Base bytes and modes are verified immediately before apply. Each
post-apply check hashes and can restore only the files the patch touches, plus a
`git status --porcelain` canary for drift elsewhere, with the check's own declared outputs excluded.
A failed check, denied settlement, cancellation, or safe cleanup path rolls the patch back through
the transaction journal.

Validation commands come only from a deterministic catalog derived from project metadata; the
analyst selects check IDs and the runtime resolves each to its exact argument vector. Models never
supply shell commands. A workspace with no discoverable checks applies with a `no_validation_checks`
degraded reason rather than failing.

Turns that stage no changes answer directly and stream. Trivial candidates — pure renames,
documentation-only edits, and single-file changes of ten lines or fewer — skip deliberation and are
promoted directly. When fewer than two usable patches survive the panel, the run promotes the lead's
own patch with a `panel_unavailable` degraded reason.

Once the lead has a staged candidate, Council never throws it away over a comparison-layer problem.
A panel, analyst, synthesis, or combined-stage failure, or the whole-run deadline or budget being
exhausted while those stages run, promotes the lead's own patch instead of losing the turn — the same
mechanism `panel_unavailable` uses, with a matching degraded reason (`analyst_failed`,
`synthesis_failed`, `deadline_exceeded`, `budget_exceeded`). Staging and applying a patch is a local
operation, so this still happens once the model-call budget itself is exhausted. Council only fails a
turn outright when the lead produced no candidate at all, or when applying or validating the winning
patch fails for safety reasons — a failed post-apply check always rolls the patch back.

Structured results and compiled packets are cached for the lifetime of one transaction. Cache keys
include the patch, base snapshot, objective, constraints, evidence, role, model, prompt version, and
schema version. The cache is bounded and never stores raw reasoning or schema-invalid output.

Each stream stores one sanitized `council_run` record with duration, outcome, degraded reason,
per-stage status, cache hit and miss counts, aggregate usage, budgets, and safe transaction state.
Budgets and one absolute deadline persist across the tool rounds of the same user turn.

## How a text answer is deliberated

A turn that produces only text — research, planning, analysis, design discussion, explanation — is
the shape Fusion was built for, and Council runs the same pipeline on it. The deliberation decision
lives in one place, `shouldDeliberateCouncilAnswer` in `review-policy.ts`, evaluated once the lead
has answered: it requires both the request and the lead's answer to look substantial (the request
past a minimum length, the answer past a minimum length or line count). Below that bar the lead's
answer returns immediately, exactly as a direct answer does today, at the cost of one physical call.
A cheap pre-check on the request alone, `mayDeliberateCouncilAnswer`, runs before the lead call so
the coordinator knows — before any text exists — whether it is safe to stream the lead's draft live;
see Streaming below.

When the turn clears the bar, the context freeze, panel, analyst, and synthesis stages are the exact
same machinery the code path uses, reached through the same `runStructuredStage` cache/repair/
fallback pipeline, with new prompt and schema version constants so no code-path cache entry can ever
be read back as a text result or vice versa:

- **Panel.** The lead's own answer — produced before any solver output exists — is panel member one.
  N-1 solvers receive the identical frozen packet and answer the same objective completely and
  standalone, with no tools and no view of each other's output. Each answer is a JSON object,
  `{"answer": "..."}`, not a patch.
- **Analyst.** Compares the answers anonymized and in hash-seeded shuffled order under the same
  "Solution A/B/C" labels the code path uses, and returns the same `FusionAnalysisSchema` — consensus,
  contradictions, partial coverage, unique insights, blind spots. `required_checks` has no meaning
  here: the schema shape is kept, but the field is always empty, and nothing on this path ever
  resolves a validation check ID or runs one.
- **Synthesis.** The lead pool writes the final answer from the analysis — consensus is the safe
  core, contradictions are where it must choose, unique insights are what it folds in — and that
  answer is the message returned to the user.

This path opens no `ChangeTransaction`, stages nothing, and never touches apply, rollback,
settlement, or the mutation guard: it is text in, text out. Fewer than two usable answers, or any
solver, analyst, synthesis, deadline, or budget failure after the lead has answered, falls back to
the lead's own answer with a degraded reason (`panel_unavailable`, `analyst_failed`,
`synthesis_failed`, `deadline_exceeded`, `budget_exceeded`) — the same mechanism the code path's
`degradeToLeadCandidate` uses, applied to an answer instead of a patch. A text turn never fails or
returns nothing because the comparison layer failed.

**Streaming.** A trivial or short text turn streams the lead's answer live, exactly as before. A
turn that clears the deliberation bar never streams the lead's draft: `mayDeliberateCouncilAnswer`
disables live streaming for the lead's own call up front, because once panel/analyst/synthesis run,
the final answer is the synthesis, not the draft, and a draft streamed live cannot be un-shown. The
synthesized answer is delivered as one buffered message, the same way a code-path answer that never
streams live is delivered today.

## Presets

Panel size is the cost dial. Choose fast for small or time-sensitive changes, normal for routine
engineering and larger implementations, and deep for complex or high-risk work. Fast's whole-run
budget is tight, so it is best suited to small or time-sensitive work rather than large
implementations.

| Model | Panel | Analysis and synthesis | Calls per code turn | Logical/physical cap | Lead/internal tokens | Stage/overall timeout |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `kimchi/council-fast` | 2 | one combined call | ~3 | 12 / 14 | 12,288 / 4,096 | 90 / 300 seconds |
| `kimchi/council` | 3 | separate calls | ~5 | 40 / 48 | 24,576 / 16,384 | 300 / 1200 seconds |
| `kimchi/council-deep` | 5 | separate calls | ~7 | 40 / 48 | 32,768 / 16,384 | 300 / 1200 seconds |

A trivial or short text turn costs one call at every preset. A text turn that clears the
deliberation bar (see [How a text answer is deliberated](#how-a-text-answer-is-deliberated)) costs
the same number of calls as a code turn at that preset, since panel size follows the same presets
and budgets/deadline apply unchanged.

## Configuration

Defaults:

| Setting | Default |
| --- | --- |
| Lead | `kimchi-dev/kimi-k2.7` |
| Panel | `kimchi-dev/glm-5.2-fp8`, `kimchi-dev/deepseek-v4-flash`, `kimchi-dev/minimax-m3` |
| Analyst | `kimchi-dev/glm-5.2-fp8` |
| Panel size | 3 |
| Stage / overall timeout | 300 / 1200 seconds |
| Lead and synthesis output | 32,768 tokens |
| Solver and analyst output | 16,384 tokens |
| Logical calls / physical attempts | 40 / 48 |
| Concurrent physical calls | 3 |
| Evidence packet / aggregate structured output | 128 KiB each |
| Aggregate input / output tokens | 786,432 / 98,304 |

Environment overrides:

| Variable | Meaning |
| --- | --- |
| `KIMCHI_COUNCIL_ENABLED` | `true` or `false`; defaults to enabled. Set to `false` to hide Council models. |
| `KIMCHI_COUNCIL_PANEL_MODELS` | Comma-separated solver pool. Members are drawn cyclically, so a panel larger than the list repeats models. |
| `KIMCHI_COUNCIL_PANEL_SIZE` | Number of panel members, 1 to 5; overrides the preset. |
| `KIMCHI_COUNCIL_ANALYST_MODEL`, `KIMCHI_COUNCIL_ANALYST_FALLBACK_MODELS` | Analyst primary and fallbacks. |
| `KIMCHI_COUNCIL_LEAD_MODEL` | Physical `provider/model` used for the lead and synthesis. |
| `KIMCHI_COUNCIL_LEAD_MAX_TOKENS` | Lead and synthesis output budget; default and hard maximum `32768`. |
| `KIMCHI_COUNCIL_INTERNAL_MAX_TOKENS` | Solver and analyst output budget; default and hard maximum `16384`. |
| `KIMCHI_COUNCIL_TIMEOUT_MS` | Whole-turn timeout; default and hard maximum `1200000`. |
| `KIMCHI_COUNCIL_MAX_LOGICAL_CALLS` | Whole-turn logical call cap; default `40` (`KIMCHI_COUNCIL_MAX_CALLS` is an alias). |

Numeric limits must be positive integers; invalid values fall back to the defaults. Environment
values form the deep ceiling, and fast and normal apply their lower preset caps afterward. Physical
references must resolve through the normal model registry and may not point back to a Council
virtual model.

A panel may legitimately contain the same model more than once. Self-fusion is a supported
configuration: comparing two independent attempts from one model is worth points on its own.

## Use

```bash
kimchi --model kimchi/council-fast
kimchi --model kimchi/council
kimchi --model kimchi/council-deep
kimchi --print --model kimchi/council "Review this repository and fix the failing test"
```

Other models remain registered and selectable. Choosing a Council preset only changes the selected
model for that run; existing `multi-model` behavior is unchanged.

Run the focused tests:

```bash
pnpm exec vitest run --dir src src/extensions/council
```

## Terminal Bench comparison

From the repository root, run the same task and attempt count for each preset and its lead baseline:

```bash
cd benchmark/terminal-bench-2
MODEL='kimchi/council-fast' ./scripts/run-local.sh -i terminal-bench/fix-git -n 1 -k 1
MODEL='kimchi/council' ./scripts/run-local.sh -i terminal-bench/fix-git -n 1 -k 1
MODEL='kimchi/council-deep' ./scripts/run-local.sh -i terminal-bench/fix-git -n 1 -k 1
MODEL='kimchi-dev/kimi-k2.7' ./scripts/run-local.sh -i terminal-bench/fix-git -n 1 -k 1
```

`run-local.sh` forwards `KIMCHI_API_KEY` and enables Council when `MODEL` starts with
`kimchi/council`. Non-default `KIMCHI_COUNCIL_*` values must be forwarded to Harbor explicitly:

```bash
MODEL='kimchi/council' ./scripts/run-local.sh \
  -i terminal-bench/fix-git -n 1 -k 1 \
  --ae 'KIMCHI_COUNCIL_PANEL_SIZE=2' \
  --ae 'KIMCHI_COUNCIL_TIMEOUT_MS=120000'
```

## Boundaries

- Responses are buffered while a code candidate is deliberated, and while a text answer is
  deliberated; a trivial or short text turn streams. The TUI shows exploring, solving, comparing,
  writing, applying, and checking labels.
- Coordination and limits are process-local.
- One user turn is one bounded transaction, even when tool execution requires several model streams.
- Council advertises text input. Every physical attempt is fitted to the selected model's context
  and output caps. The virtual model's picker limits are static because provider registration
  happens before the session `ModelRegistry` is available; runtime fitting remains authoritative.
- Evidence strings are redacted fail-closed and remain data, never instructions to a solver or the
  analyst.
- Supported candidate mutations are UTF-8 file create, update, delete, and rename. Traversal,
  symbolic links, case and physical path aliases, directories, binary content, concurrent base
  drift, and unsupported operations fail closed.
- Candidate size is bounded at 64 files, 12,000 changed lines, and 512 KiB.
- The virtual model advertises zero USD rates; it is not a pricing contract for the physical calls.
- Child calls use `ModelRegistry` lookup and auth, preserve request and response callbacks and safe
  session headers, and attach explicit virtual, run, stage, and physical metadata. Virtual-provider
  auth, arbitrary headers, and environment values are not forwarded; provider retries are disabled
  and counted locally.
- Catalog metadata does not prove that every physical model is equally reliable at structured JSON.

A production version should move orchestration behind a thin first-class Council API while
preserving `kimchi/council` as the harness-facing model contract.
