# Expected Execution Scenarios

How each benchmark task should execute given the starting model and the
available model pool. Two starting scenarios per task: **kimi-k2.6** (heavy,
strengths: research/plan/review) and **minimax-m2.7** (standard, strengths:
build/review).

The orchestrator can either **spawn a subagent** with a different model or
**switch the session model** mid-conversation. Model switching avoids the
context-loss overhead of a subagent but means the remaining conversation
runs on the new model's token pricing and capabilities.

Available models:

| Model | Tier | Strengths | Cost | Notes |
|-------|------|-----------|------|-------|
| kimi-k2.6 | heavy | research, plan, review | $$$ | Best reasoning, vision |
| minimax-m2.7 | standard | build, review | $$ | Best coder |
| nemotron-3-super | light | build, explore | $ | 1M context, cheapest, weakest at complex code |

---

## Task 1 — Simple (Go HTTP Rate Limiter)

Single-file, no design decisions, no existing codebase.

### Starting model: kimi-k2.6

```
classify  → simple
steps     → build
```

Kimi does not have `build` in its strengths. Two options:

**Option A — subagent (preferred):**
Spawn one minimax-m2.7 subagent with the full prompt. Kimi's orchestration
overhead is minimal (classify + one tool call). Total: ~20k kimi + ~200k
minimax.

**Option B — model switch:**
Switch to minimax-m2.7, then build. Saves the subagent spawn overhead but
wastes kimi tokens on the initial classify turn. Total: ~10k kimi + ~200k
minimax. Slightly cheaper because no subagent framing.

**Optimal:** Option B. The task is simple enough that the context loss from
a subagent buys nothing — there is no plan or prior exploration to carry
forward. Switching is cheaper.

### Starting model: minimax-m2.7

```
classify  → simple
steps     → build
```

Minimax has `build` in its strengths. Does the work itself, no delegation.
Single-model run. Total: ~200k minimax.

**Optimal:** Direct execution. No switching, no subagents.

---

## Task 2 — Complex (Go REST API, layered architecture)

Multi-file, requires architectural decisions, greenfield.

### Starting model: kimi-k2.6

```
classify  → complex
steps     → plan, build
```

Kimi has `plan` in its strengths. Per the orchestrator rules, heavy-tier
models always plan themselves.

**Option A — plan then subagent:**
Kimi writes the plan (interfaces, file paths, method signatures) to a spec
file. Spawns one minimax-m2.7 subagent with the spec file attached for the
build phase. After the subagent returns, kimi reads the output and verifies.
Total: ~80k kimi (plan + verify) + ~300k minimax (build).

**Option B — plan then model switch:**
Kimi writes the plan, then switches to minimax-m2.7 for the build phase.
Minimax inherits the full conversation context including the plan — no need
to serialize it to a file. After building, minimax can also run tests
(review is in its strengths). Total: ~80k kimi + ~300k minimax, but all
minimax tokens carry the kimi context prefix, so the effective input cost
is slightly higher per turn. However, minimax sees the plan inline which
reduces misinterpretation risk.

**Optimal:** Option B. The plan is short enough that context inheritance
beats serialization. Avoids the risk of the subagent misreading the spec
file. One fewer failure mode.

### Starting model: minimax-m2.7

```
classify  → complex
steps     → plan, build
```

Minimax does not have `plan` in its strengths. Per the orchestrator rules,
standard-tier models must delegate planning.

**Option A — subagent for plan, then build:**
Spawn a kimi-k2.6 subagent for the plan phase. Kimi writes the spec to a
file. Minimax reads the file, then builds. Total: ~80k kimi (subagent) +
~300k minimax (build).

**Option B — switch to kimi for plan, switch back for build:**
Switch to kimi-k2.6. Kimi plans (writes spec to file or inline). Switch
back to minimax-m2.7. Minimax builds from the plan already in context.
Total: same token volume, but minimax has full plan context from the
conversation history, reducing the chance of drift.

**Optimal:** Option B. Two model switches but better context continuity.
The plan stays in the conversation — minimax does not need to re-read a
file. Downside: two switch operations add latency (~2-3s each).

---

## Task 3 — Research (Go HTTP router libraries)

Pure information retrieval. No code, no codebase.

### Starting model: kimi-k2.6

```
classify  → simple
steps     → research
```

Kimi has `research` in its strengths. Per the simple-research exception in
the orchestrator rules, any model can handle this directly via web_search.
Kimi calls web_search, reads results, formats the answer. Total: ~20k kimi.

**Optimal:** Direct execution. No switching, no subagents.

### Starting model: minimax-m2.7

```
classify  → simple
steps     → research
```

Minimax does not have `research` in its strengths, but the simple-research
exception applies: "If a task only needs a quick factual lookup, call
web_search directly — do NOT delegate to a subagent." Minimax calls
web_search and answers. Total: ~20k minimax.

**Optimal:** Direct execution. The simple-research exception overrides
strengths-based delegation. Cheaper than kimi and equally correct for a
3-item list.

---

## Task 4 — Mega (Go Concurrent Build System)

Multi-package, complex algorithms, extensive tests. Requires deep planning.

### Starting model: kimi-k2.6

```
classify  → complex
steps     → plan, build, review
```

Kimi has `plan` and `review`. Does not have `build`.

**Option A — plan, parallel subagents, review:**
Kimi writes the plan (package interfaces, file layout, method signatures).
Spawns 3 parallel minimax-m2.7 subagents:
  - Subagent 1: parser package + tests
  - Subagent 2: graph package (topo sort, cycle detection) + tests
  - Subagent 3: engine package (worker pool, SIGINT) + cli + main.go + tests
After all return, kimi reviews the output, runs `go build` and `go test`,
spawns a fix-up subagent if needed. Total: ~100k kimi + ~600k minimax
(3 x 200k).

**Option B — plan, switch to minimax, build sequentially:**
Kimi writes the plan, switches to minimax. Minimax builds all packages
sequentially. Switches back to kimi for review. Total: ~100k kimi + ~400k
minimax. Fewer total tokens (no subagent framing, no duplicated context)
but longer wall-clock time because builds are sequential.

**Option C — plan, switch to minimax for build, spawn parallel minimax subagents:**
Kimi writes the plan, switches to minimax. Minimax spawns 2-3 minimax
subagents for parallel package implementation while building one package
itself. Switches back to kimi for review. Hybrid approach: best of both
parallelism and context continuity.

**Optimal:** Option A for wall-clock time, Option B for cost. Option C is
a reasonable middle ground. The mega task benefits from parallelism because
the packages are independently implementable — Option A is the expected
path.

### Starting model: minimax-m2.7

```
classify  → complex
steps     → plan, build, review
```

Minimax does not have `plan`. Must delegate planning.

**Option A — switch to kimi for plan, switch back for build:**
Switch to kimi-k2.6. Kimi writes the plan. Switch back to minimax. Minimax
builds all packages, possibly spawning parallel minimax subagents for
independent packages. Minimax self-reviews (has `review` in strengths).
Total: ~100k kimi + ~500k minimax.

**Option B — kimi subagent for plan, minimax builds:**
Spawn a kimi-k2.6 subagent for the plan. Minimax reads the spec file, then
builds. Can spawn parallel minimax subagents for independent packages.
Minimax self-reviews. Total: ~100k kimi + ~500k minimax. Similar cost but
minimax loses the conversation context from the planning phase.

**Option C — switch to kimi for plan, switch back, spawn parallel builds:**
Switch to kimi. Kimi plans. Switch back to minimax. Minimax spawns 2-3
parallel minimax subagents for independent packages, builds one package
itself, then reviews. Total: ~100k kimi + ~500k minimax. Best balance of
context continuity and parallelism.

**Optimal:** Option C. Kimi plans in-session (full context preserved on
switch-back), minimax parallelizes the build for wall-clock speed, minimax
handles its own review.

---

## Task 5 — Explore + Refactor (Input validation on existing API)

Existing codebase (~850 lines, 13 files). Requires reading before acting.

### Starting model: kimi-k2.6

```
classify  → complex
steps     → explore, plan, build
```

Kimi has `plan` but not `explore` or `build`.

**Option A — nemotron subagent explores, kimi plans, minimax subagent builds:**
Spawn a nemotron-3-super subagent to explore the codebase and produce a
findings document (list of all handlers, their validation status, and
identified gaps). Kimi reads the findings, writes a plan (which handlers
to fix, what validation to add, what tests to write). Spawns a minimax-m2.7
subagent with the plan + file paths to implement the fixes and tests.
Total: ~50k nemotron (explore) + ~80k kimi (plan) + ~250k minimax (build).
All three models used, each on its strength.

**Option B — kimi explores itself (it can read files), then plans, then delegates build:**
Kimi reads the handler files directly (it has tool access). Skips the
explore subagent. Plans. Delegates build to minimax. Total: ~150k kimi
(explore + plan) + ~250k minimax (build). Simpler but kimi's explore tokens
are expensive. This violates the strengths rule — kimi does not have
`explore` in its strengths.

**Option C — nemotron explores, kimi plans, switch to minimax for build:**
Spawn nemotron for explore. Kimi reads findings and plans. Switch to
minimax for build. Minimax inherits the plan from context and builds.
Total: ~50k nemotron + ~80k kimi + ~250k minimax. Same cost as Option A
but minimax has better context continuity — it sees the plan inline instead
of via a file attachment.

**Optimal:** Option C. Three-model pipeline with model switching for the
build phase. Nemotron is the cheapest explorer (1M context ingests the
entire project in one pass). Kimi plans from the exploration findings.
Minimax builds with full context. This is the flagship scenario for the
explore task — all three tiers exercised.

### Starting model: minimax-m2.7

```
classify  → complex
steps     → explore, plan, build
```

Minimax does not have `explore` or `plan`. Must delegate both.

**Option A — nemotron subagent explores, kimi subagent plans, minimax builds:**
Spawn nemotron-3-super subagent to explore. Read the findings file. Spawn
kimi-k2.6 subagent to plan (pass findings file as attachment). Read the
plan file. Build the fixes (minimax has `build`). Total: ~50k nemotron +
~80k kimi + ~250k minimax. Clean separation but two subagents lose context.

**Option B — switch to nemotron for explore, switch to kimi for plan, switch back for build:**
Switch to nemotron. Nemotron reads the codebase, writes findings (inline or
to a file). Switch to kimi. Kimi reads the findings from context, writes
the plan. Switch back to minimax. Minimax builds with full conversation
history containing both explore findings and plan. Total: ~50k nemotron +
~80k kimi + ~250k minimax. Three model switches but perfect context
continuity throughout the pipeline.

**Option C — switch to kimi (plan + explore combined), switch back for build:**
Switch to kimi. Kimi has enough general capability to both explore and plan
in a single pass (it can read files, it just does not list `explore` as a
strength). Switch back to minimax for build. Total: ~150k kimi + ~250k
minimax. Fewer switches but uses expensive kimi tokens for exploration work
that nemotron could do cheaper.

**Optimal:** Option B. The three-switch pipeline (nemotron -> kimi ->
minimax) is the most cost-efficient path and exercises each model on its
strength. The conversation history carries forward through each switch, so
every model sees what the previous one did. This is the ideal execution for
the explore task.

---

## Summary: Expected Execution Matrix

### Starting model: kimi-k2.6

| Task | Phases | Execution | Subagents | Switches | Est. cost |
|------|--------|-----------|-----------|----------|-----------|
| Simple | build | switch to minimax, build | 0 | 1 | $ |
| Complex | plan, build | kimi plans, switch to minimax for build | 0 | 1 | $$ |
| Research | research | kimi answers directly via web_search | 0 | 0 | $ |
| Mega | plan, build, review | kimi plans, spawn 3 parallel minimax subagents, kimi reviews | 3 | 0 | $$$$ |
| Explore | explore, plan, build | nemotron subagent explores, kimi plans, switch to minimax for build | 1 | 1 | $$$ |

### Starting model: minimax-m2.7

| Task | Phases | Execution | Subagents | Switches | Est. cost |
|------|--------|-----------|-----------|----------|-----------|
| Simple | build | minimax builds directly | 0 | 0 | $ |
| Complex | plan, build | switch to kimi for plan, switch back for build | 0 | 2 | $$ |
| Research | research | minimax answers directly via web_search | 0 | 0 | $ |
| Mega | plan, build, review | switch to kimi for plan, switch back, spawn 2-3 parallel minimax subagents, minimax reviews | 2-3 | 2 | $$$$ |
| Explore | explore, plan, build | switch to nemotron (explore), switch to kimi (plan), switch back (build) | 0 | 3 | $$$ |

### Key design principle

**Use model switching when context continuity matters and work is sequential.
Use subagents when work can be parallelized or is fully self-contained.**

Model switching preserves the full conversation history — the next model
sees everything the previous model did. This eliminates the need to
serialize context into files and the risk of the subagent misinterpreting
a spec. The trade-off is that all subsequent tokens carry the accumulated
context prefix cost and work must be sequential.

Subagents are better when:
- Multiple independent tasks can run in parallel (mega task build phase)
- The subtask is fully self-contained and does not need prior conversation context
- The parent model needs to continue doing other work while the subagent runs
