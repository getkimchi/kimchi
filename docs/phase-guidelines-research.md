# Phase Guidelines — Research & Rationale

This document consolidates the research behind the phase-aware system-prompt guidelines (default phase guidelines + per-model overrides) shipped in `src/extensions/orchestration/prompt-transformer/default-phase-guidelines.ts` and `src/extensions/orchestration/model-registry/builtin-models.ts`.

Every guideline below traces back to either:
- internal session evidence (`.kimchi/docs/session-01-findings.md`, `.kimchi/docs/improvement-plan-iter4.md`), or
- public, primary-source reports of model-specific behaviour (linked inline).

If you change a guideline, update this document with the evidence supporting the change.

---

## 1. Why phase-scoped guidelines

Generic system prompts apply the same rules to every step of a task. In practice, the *correct* behaviour for `explore` (read broadly, do not edit) directly contradicts the correct behaviour for `build` (edit precisely, do not re-explore). Stuffing both into a single prompt forces the model to discriminate at runtime, which it does inconsistently — especially on smaller tiers.

The prompt-transformer therefore appends a `## Phase Guidelines (<phase>)` section to every system prompt at runtime, sourced from:

1. The model's `guidelines[phase]` override, if defined (`builtin-models.ts`).
2. Otherwise the `DEFAULT_PHASE_GUIDELINES[phase]` (`default-phase-guidelines.ts`).

The five phases are `explore`, `research`, `plan`, `build`, `review`.

---

## 2. Internal evidence — what we observed

Two internal documents drove the universal (default) guidelines:

### 2.1 Session 01 findings

Source: [`.kimchi/docs/session-01-findings.md`](../.kimchi/docs/session-01-findings.md)

Key signals across 8 benchmark runs:

| Pattern | Evidence | Implication for guidelines |
|---|---|---|
| **kimi-k2.5 emits partial text fragments as tool calls** (`"(m"`, `"model"`, `"Setup"`, `".Run"`) — 6 "Tool not found" errors in one session, file rewritten 7 times | `complex-single-kimi-k2.5` — 819.8k tokens, FAIL | Kimi-K2.5 `build` override: "Emit complete, well-formed tool calls only. Never output partial fragments..." |
| **Subagent failures cascade into duplicate work** — orchestrator does the work itself after the subagent fails, doubling token spend | `simple-kimi-k2.5` (210k wasted before retry); `complex-minimax-m2.7` (5 min + protocol violation before retry) | Default `plan`: "Save the spec... build phase reads from there — do not redo discovery in build." |
| **Subagent budgets too generous for simple tasks** | `simple-minimax-m2.7` succeeded at 102k while `simple-kimi-k2.5` subagent burned 210k on the same workload | Default `build`: "Stay in scope: do NOT add features, refactors, or 'improvements' beyond what the spec asks for." |
| **MiniMax over-thinks tool calls and over-reaches scope** | `complex-minimax-m2.7` — 11m21s, 285.4k, FAIL | MiniMax `build` override: "Outline-then-diff", "STAY IN SCOPE", "Limit each turn to a single focused goal." |

### 2.2 Improvement plan iter4

Source: [`.kimchi/docs/improvement-plan-iter4.md`](../.kimchi/docs/improvement-plan-iter4.md)

Key issues:

- **Issue 1 — standard-tier models reflexively delegate research.** `minimax-m2.7` (standard tier, no `research` strength) was delegating trivial `web_search` calls to subagents on 3/4 sessions, costing 47k–256k tokens vs. ~13k for direct calls. Cause: the orchestrator prompt rule "If your tier is `standard` and the task requires `research` steps: you must delegate." → Default `research` guideline now states explicitly: *"`web_search` is available to ALL models regardless of tier or strengths. Prefer it over delegating a simple lookup."*
- **Issue 2 — high token variance in build loops** (2–9× across runs, 23–46 turns on minimax). → Default `build`: *"Batch independent tool calls in a single turn — fewer turns = less context accumulation."*
- **Issue 3 — empty tool-call name `{"name": "", ...}`.** Confirmed unfixable in the extension layer (validation happens in pi-agent-core before our hook); not addressed via guidelines.

---

## 3. External research — model-specific flaws

The per-model overrides in `builtin-models.ts` are grounded in primary-source reports of each model's documented failure modes. Sources are linked inline.

### 3.1 MiniMax M2 family (`minimax-m2.7`)

Tier: standard. Strengths: build, review. Override scope: `build`, `review`.

**Documented flaws:**

1. **Tool-calling weaknesses on consecutive calls** — over-thinks simple tool execution, ignoring brevity constraints in the system prompt. The official maintainers document a "minimal thinking on tool exec, save reasoning for planning" practice.
   Source: [MiniMax-AI/MiniMax-M2 Issue #77](https://github.com/MiniMax-AI/MiniMax-M2/issues/77), [MiniMax M2 best-practices (official platform docs)](https://platform.minimax.io/docs/token-plan/best-practices)
2. **Drops items from long structured lists in the system prompt.** Reported by users on M2.5; the "thoughtfully disobedient" failure mode persists in M2.7. Implies prompts must be tight and ordered by priority.
   Source: [MiniMax-AI/MiniMax-M2.5 Issue #3](https://github.com/MiniMax-AI/MiniMax-M2.5/issues/3)
3. **Scope creep / unsolicited refactors.** M2 commonly adds error handling, abstractions, or concurrency primitives the task did not request. Defaults to mutex-based concurrency in Go even when no concurrency was requested.
   Source: [Verdent — "What is MiniMax M2 Coding"](https://www.verdent.ai/es/guides/what-is-minimax-m2-coding) (failure-mode analysis from production usage)
4. **Hallucinated APIs** — calls library methods that don't exist on the version in use when uncertain.
   Source: same as above (Verdent analysis); corroborated by the official M2 best-practices doc warning to "verify before calling".
5. **Internal step-limit ~100 tool calls per turn**, after which behaviour degrades. Implies "limit each turn to a single focused goal".
   Source: [MiniMax M2 best-practices](https://platform.minimax.io/docs/token-plan/best-practices)
6. **Strong long-task state tracking** when goals are limited per turn — informs the "outline-then-diff, one focused goal per turn" pattern.
   Source: same

**Override mapping:**

| Symptom | Guideline line |
|---|---|
| Drops items from long lists | "Outline-then-diff: state the change in 1–3 bullets, then emit the minimal diff." |
| Scope creep | "STAY IN SCOPE. Do NOT add features, error handling, concurrency primitives, or abstractions the task did not explicitly ask for." |
| Mutex over-use in Go | "Do NOT default to mutex-based concurrency in Go (or any pattern not specified)." |
| Hallucinated APIs | "Verify library methods exist before calling them — do NOT hallucinate APIs." |
| Step-limit / over-thinking | "Limit each turn to a single focused goal." |
| Edit-loop variance (Session 01) | "Run the type-checker / linter / tests FIRST to narrow the error list before fixing anything." + "Batch independent `edit` calls aggressively." |

The matching `review` override flags these same failure modes when M2.7 is reviewing another model's work — the most common scope-creep symptoms appear as inline rewrites and unsolicited new abstractions.

### 3.2 Kimi K2.5 (`kimi-k2.5`)

Tier: heavy. Strengths: explore, research, plan, review. Override scope: `build`, `explore`.

**Documented flaws:**

1. **Infinite tool-call loops on consecutive tool calls.** After a tool result, K2.5 sometimes re-issues the same call instead of producing text. Fixed by an explicit "after tool results, generate text response" instruction.
   Source: [MoonshotAI/Kimi-K2.5 Issue #24](https://github.com/MoonshotAI/Kimi-K2.5/issues/24)
2. **Outputs literal text in place of native tool calls** — fragments like `"(m"`, `"model"` reach the runtime as if they were tool names. This matches Session 01's `complex-single-kimi-k2.5` failure exactly.
   Source: [Kilo-Org/kilocode PR #5722](https://github.com/Kilo-Org/kilocode/pull/5722) (community fix for Kimi tool-calling reliability), corroborated by Session 01.
3. **Hesitates on big mixed-goal prompts** — degrades when a single turn asks for unrelated goals; works best when goals are split into chunks.
   Source: same PR #5722 thread + community reports linked from it.
4. **Plan-first prompts work best** — the model has a natural "plan-first" groove; cooperative and asks permission before tool calls when prompted to.
   Source: same.
5. **Long messy inputs degrade quality** — chunking and labelling sections is recommended.
   Source: same.

**Override mapping:**

| Symptom | Guideline line |
|---|---|
| Infinite tool-call loop | "After every tool result, ALWAYS produce text... Never re-issue the same tool call after a successful result." |
| Partial text fragments as tool calls | "Emit complete, well-formed tool calls only. Never output partial fragments..." |
| Big mixed-goal hesitation | "Split big mixed-goal prompts into chunks." |
| Plan-first groove | "Plan-first: before the first tool call, outline 3–5 steps in plain text, then execute step 1." |
| Long messy inputs | (in `explore` override) "Chunk and label long inputs — do NOT pour an entire codebase into one mental pass; group by module." |

### 3.3 Kimi K2.6 (`kimi-k2.6`)

Tier: heavy. Strengths: explore, research, plan, review. Override scope: `plan`, `explore`.

**Documented strengths/practices:**

1. **Agent-swarm orchestration primitives** — K2.6 is tuned for long-horizon planning and works best when given a *queue* of independent sub-tasks rather than a single monolithic instruction.
   Source: [Kimi K2.6 release notes (kimi-k2.org)](https://kimi-k2.org/blog/24-kimi-k2-6-release)
2. **Built-in context compression** — manual mid-task summarisation hurts more than it helps; trust the compressor.
   Source: same release notes.
3. **Tuned at temperature=1.0, top_p=1.0** — lowering either degrades quality. (Not a guideline-level concern; the harness uses recommended defaults.)
   Source: same.

**Override mapping:**

| Practice | Guideline line |
|---|---|
| Queue-not-question | "Decompose ambitious tasks into a queue of independent sub-tasks the build phase can pull from — K2.6 plans best when given a queue, not a single monolithic instruction." |
| Trust the compressor | "Trust the built-in context compressor — do NOT manually summarise mid-exploration." |
| Long-context strength | "Use your long-context strength: prefer reading 3–5 files in full over many partial reads." |

### 3.4 Nemotron 3 Super FP4 (`nemotron-3-super-fp4`)

Tier: light. Strengths: build only. Override scope: `build`.

**Documented profile:**

1. **1M-token context window with near-perfect retrieval** (NIAH-class) — strong at codebase-wide reads.
2. **Weakest at coding accuracy in the pool** — not reliable on multi-file changes.

Public sources for the architecture/benchmark profile:
- [Nemotron model family overview — NVIDIA Build](https://build.nvidia.com/nvidia/nemotron-3-super-49b)
- [Nemotron technical report (NVIDIA research)](https://research.nvidia.com/publication/2024-08_nemotron-4-340b)

(Note: there are no widely-published failure-mode reports specific to FP4 quantisation of this model — the override is therefore conservative and based on the in-pool benchmark observation that it is the lowest-accuracy coder.)

**Override mapping:**

| Property | Guideline line |
|---|---|
| Weak coding accuracy | "Stay strictly within the spec. Do NOT design, refactor, or expand scope. If the spec is ambiguous, stop and report — do not improvise." |
| Multi-file unreliability | "Touch one file at a time when possible. Avoid multi-file refactors." |
| Long-context strength | "Read each file in full before editing — your 1M context window is a strength, use it." |
| Generic safety (light tier) | "If a fix attempt fails twice, stop and report the error rather than retrying blindly." |

### 3.5 Claude Opus 4.7 (`claude-opus-4-7`)

Tier: heavy. Strengths: explore, research, plan, review. Override scope: `plan`, `explore`, `review`.

**Documented profile:**

1. **Strongest planner in the pool** — but tendency to over-plan and over-explore on simple tasks. Anthropic's own guidance is to keep plan depth proportional to task complexity.
   Source: [Anthropic — "Claude Code: best practices for agentic coding"](https://www.anthropic.com/engineering/claude-code-best-practices), [Anthropic prompt-engineering guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering)
2. **Verbose by default** — needs explicit "be decisive, top N findings" framing in `review` to avoid noise.
   Source: same prompt-engineering guide.
3. **Strong at structured output** — interfaces, file paths, function signatures are first-class artefacts, not prose.
   Source: same.

**Override mapping:**

| Tendency | Guideline line |
|---|---|
| Over-planning on simple tasks | "Match plan depth to task complexity. A single-file edit needs a 5-line spec, not a treatise." |
| Verbosity in plans | "Lead with concrete artefacts: file paths, function signatures, interfaces. Prose is supporting material, not the headline." |
| Over-exploration | "Resist over-exploration. Stop when you have the integration points needed to plan, not when you have read every file." |
| Verbose review | "Be decisive — call out the top 3–5 issues, not every observation." |

---

## 4. Cross-cutting principles in the default guidelines

Five universal rules apply regardless of model. Each is grounded in either internal evidence or widely-cited prompt-engineering practice.

### 4.1 `explore` — "stop when enough"

> *"Stop as soon as you have enough context to plan. Over-exploring wastes tokens."*

Grounded in Session 01's token-variance observation and Anthropic's "minimum viable context" principle. ([Anthropic prompt-engineering guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering))

### 4.2 `research` — "tier doesn't gate web_search"

> *"`web_search` is available to ALL models regardless of tier or strengths. Prefer it over delegating a simple lookup."*

Direct fix for Issue 1 in `improvement-plan-iter4.md`. The previous orchestrator-prompt rule forced standard-tier models to delegate even trivial lookups, costing 10–20× the tokens.

### 4.3 `plan` — "interfaces over prose, save once, read once"

> *"Save the spec as a markdown file in the Documents directory. The build phase reads from there — do not redo discovery in build."*

Grounded in Session 01's "subagent failure cascades duplicate work" pattern and the agent-handoff design from the Anthropic agent-design playbook. ([Anthropic — Building effective agents](https://www.anthropic.com/research/building-effective-agents))

### 4.4 `build` — "read before edit, batch in single turns, stay in scope"

> *"Read each file BEFORE modifying it. Never edit blind."*
> *"Batch independent tool calls in a single turn — fewer turns = less context accumulation."*
> *"Stay in scope: do NOT add features, refactors, or 'improvements' beyond what the spec asks for."*

Grounded in Issue 2 (token variance in edit/test/fix loops) and the cross-model scope-creep observations. The "outline-then-diff" framing comes from the MiniMax best-practices doc but generalises.

### 4.5 `review` — "prioritise, quote, do not rewrite"

> *"Prioritise: correctness bugs > security issues > architectural concerns > edge cases > style. Skip nits."*
> *"Do NOT rewrite code inline unless explicitly asked."*

Standard practice from the Anthropic prompt-engineering guide and aligns with M2's known failure mode of inline rewriting during review.

---

## 5. References

### Internal

- [`.kimchi/docs/session-01-findings.md`](../.kimchi/docs/session-01-findings.md) — 8-run benchmark analysis, hard-failure root causes.
- [`.kimchi/docs/improvement-plan-iter4.md`](../.kimchi/docs/improvement-plan-iter4.md) — cross-session issue inventory and proposed prompt changes.
- [`.kimchi/docs/model-overrides-and-phase-guidelines-spec.md`](../.kimchi/docs/model-overrides-and-phase-guidelines-spec.md) — exact spec used to apply this work.
- [`.kimchi/docs/model-phase-guidelines-spec.md`](../.kimchi/docs/model-phase-guidelines-spec.md) — original design of the phase-guideline mechanism.

### MiniMax M2 family

- [MiniMax-AI/MiniMax-M2 — Issue #77 (function-calling weaknesses)](https://github.com/MiniMax-AI/MiniMax-M2/issues/77)
- [MiniMax-AI/MiniMax-M2.5 — Issue #3 (list-enumeration omissions)](https://github.com/MiniMax-AI/MiniMax-M2.5/issues/3)
- [MiniMax M2 best-practices (official platform docs)](https://platform.minimax.io/docs/token-plan/best-practices)
- [Verdent — "What is MiniMax M2 Coding" (production failure-mode analysis)](https://www.verdent.ai/es/guides/what-is-minimax-m2-coding)

### Kimi K2 family

- [MoonshotAI/Kimi-K2.5 — Issue #24 (infinite tool-call loop)](https://github.com/MoonshotAI/Kimi-K2.5/issues/24)
- [Kilo-Org/kilocode — PR #5722 (Kimi tool-calling reliability fix)](https://github.com/Kilo-Org/kilocode/pull/5722)
- [Kimi K2.6 release notes — kimi-k2.org](https://kimi-k2.org/blog/24-kimi-k2-6-release)

### Nemotron

- [Nemotron 3 Super 49B — NVIDIA Build](https://build.nvidia.com/nvidia/nemotron-3-super-49b)
- [Nemotron 4 340B technical report — NVIDIA Research](https://research.nvidia.com/publication/2024-08_nemotron-4-340b)

### Claude / Anthropic

- [Claude Code — best practices for agentic coding](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Anthropic — prompt-engineering guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering)
- [Anthropic — Building effective agents](https://www.anthropic.com/research/building-effective-agents)

---

## 6. How to extend

When adding a new model or refining a guideline:

1. Reproduce the failure (or strength) at least once in a benchmark or session capture, and record it under `.kimchi/docs/`.
2. Find at least one corroborating primary source — official docs, GitHub issue, or release notes — and link it in this document.
3. Update the matching `MODEL_CAPABILITIES` entry in `src/extensions/orchestration/model-registry/builtin-models.ts` and re-run `pnpm run typecheck && pnpm run lint && pnpm run test`.
4. Add a row to the relevant override-mapping table in §3 of this document and a new entry under §5 References.

Treat this document as the single source of truth for *why* each guideline exists. Code comments in `builtin-models.ts` should reference back here, not duplicate the rationale.
