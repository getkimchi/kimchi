---
title: Kimchi Cohesion-Aware Multi-Agent Execution
subtitle: Implementation design, evidence, prototype interfaces, rollout plan, and tracked backlog
status: Draft for implementation
repository: getkimchi/kimchi
repository_snapshot: 4cb2f4460db990f1db53bda1cf8c5f0352541f14
date: 2026-08-16
canonical_tracker: kimchi-cohesion-aware-multi-agent-tasks.yaml
---

# Kimchi Cohesion-Aware Multi-Agent Execution

**Implementation design, evidence, prototype interfaces, rollout plan, and tracked backlog**

**Status:** Draft for implementation  
**Target:** Kimchi harness (`getkimchi/kimchi`)  
**Repository snapshot inspected:** `4cb2f4460db990f1db53bda1cf8c5f0352541f14`  
**Date:** 2026-08-16  
**Canonical task tracker:** `kimchi-cohesion-aware-multi-agent-tasks.yaml`

> This document is written for coding agents and human reviewers. It is deliberately implementation-oriented. Architecture decisions, public interfaces, acceptance criteria, and evidence are explicit so workers do not repeatedly rediscover the same problem and charge us for the privilege.

## Document purpose

This document defines how to add useful multi-agent coordination to Kimchi without making a worktree, branch, or chat room the primary abstraction.

The design has five goals:

1. Preserve real parallel execution where work is genuinely independent.
2. Keep tightly coupled work under one persistent worker so agents do not duplicate repository archaeology.
3. Release downstream work immediately when its actual dependencies are satisfied, without global waves.
4. Exchange compact, grounded handoffs instead of forwarding reasoning transcripts.
5. Represent published source changes and conflicts as durable operations rather than as agent-owned branches.

The implementation is staged. The first shippable milestone improves planning, scheduling, handoffs, and measurement using Kimchi's existing Ferment and subagent infrastructure. The source-operation model follows after the orchestration semantics are proven. Copy-on-write execution scopes and competitive speculation are separate later work.

## How coding agents must use this document

Before claiming a task:

1. Read repository `AGENTS.md` and obey its package, test, formatting, and upstream-investigation rules.
2. Read the architecture decisions in this document.
3. Open `kimchi-cohesion-aware-multi-agent-tasks.yaml`.
4. Claim only a task whose dependencies are complete.
5. Set `status: in_progress`, `owner_agent`, and `started_at` in the YAML tracker.
6. Implement the smallest complete task scope. Do not silently extend the architecture.
7. Add or update colocated tests.
8. Record commands and evidence in the task entry.
9. Set `status: done` only after all acceptance criteria pass.
10. When an architecture assumption is wrong, add a decision record before changing the design.

The YAML tracker is the machine-readable execution ledger. This document is the design authority. If they disagree, stop and record a decision rather than choosing whichever version is easier to implement.

# 1. Executive decision

## 1.1 One-sentence architecture

Kimchi will group tightly coupled work into persistent task groups, schedule dependency-ready groups asynchronously, publish compact Action-State-Result handoffs at real boundaries, and record source changes as versioned operations with explicit conflicts.

## 1.2 Normal execution path

```text
User request
    -> Ferment planner creates steps and explicit dependencies
    -> Cohesion validator groups tightly coupled steps
    -> Event-driven scheduler finds ready task groups
    -> Ready groups run physically in parallel, up to a budgeted worker limit
    -> Each group keeps one persistent worker session
    -> Worker publishes a structured handoff and a ChangeOperation reference
    -> Only direct dependents are unblocked or notified
    -> Central verification runs against the canonical state
    -> Failed verification creates a localized repair task for the owning group
    -> Ferment completes after all required groups and verification gates pass
```

## 1.3 What is intentionally not the primary design

The following are not the coordination model:

- `subagent = worktree`
- `subagent = branch`
- one agent per file
- all agents reading a shared chat feed
- every file read becoming a mandatory invalidation edge
- start everything immediately and reconcile later
- fixed global execution waves
- a strong supervisor reviewing every model turn

A temporary materialization backend may use existing isolation mechanisms in a narrowly defined compatibility mode, but no task, agent, scheduler, or persisted plan may depend on a worktree identity.

## 1.4 Expected benefit

The design should improve:

- **Wall-clock time:** independent groups execute simultaneously and downstream groups start as soon as their own prerequisites complete.
- **Correctness:** unstable shared boundaries are settled before consumers start; conflicts become explicit objects.
- **Cost:** persistent group workers reuse context; handoffs are compact; failed work is retried locally.
- **Small-model viability:** workers receive narrow, stable tasks with explicit state and verification instead of having to infer a distributed system from chat.
- **Observability:** Kimchi can measure useful work, duplicated exploration, coordination cost, discarded work, conflict rate, and critical-path savings.

The design does not assume multi-agent execution is always cheaper. It must be able to select a single worker when the dependency graph shows little useful parallelism.

# 2. Problem statement

Kimchi already supports background subagents, steering, resume, structured agent reports, Ferment phases and steps, parallel cohorts, event persistence, verification, grading, model roles, and token budgets. The missing layer is a reliable answer to these questions:

1. Which parts of a task should be owned by the same worker?
2. Which parts can run at the same time without duplicating design work?
3. When is a downstream task actually ready?
4. What exact information must cross an agent boundary?
5. How is a published code change identified, inspected, composed, or rejected?
6. How does Kimchi recover one failed task without restarting unrelated work?
7. When should a cheap model be used, and when should a strong model intervene?

Current parallel execution can group manually marked phases or steps, but it does not provide a general dependency graph, cohesion-aware grouping, versioned boundary publication, or a canonical change-operation model. Direct messaging solves delivery, not relevance or consistency.

## 2.1 The false-parallelism failure mode

A naive system starts several agents immediately:

```text
Agent one designs an interface
Agent two implements a client against a guessed interface
Agent three writes tests against another guessed interface
```

If the guesses differ, the system pays for:

- duplicated codebase exploration;
- incompatible implementation;
- repeated tests;
- cross-agent explanation;
- reconciliation;
- discarded output.

The wall clock may look parallel while total reasoning and cost increase. This is speculative concurrency, not useful parallelism.

## 2.2 The desired form of parallelism

Serialize only the smallest unstable boundary, then fan out:

```text
Publish stable session contract
    -> session implementation
    -> HTTP client update
    -> validation update
    -> tests and documentation
```

The contract decision is serial because it is causally shared. The larger consumer tasks are parallel because their input is stable.

# 3. Scope and non-goals

## 3.1 In scope

- Extend Ferment with task groups, arbitrary dependencies, boundaries, assignments, handoffs, operations, and conflicts.
- Event-driven ready-queue scheduling without global waves.
- Persistent worker assignment per task group.
- Structured Action-State-Result handoffs.
- Direct-dependent routing, not team-wide broadcast.
- Central verification and localized repair.
- File/resource ownership checks for the first implementation.
- First-class source snapshots and change operations.
- Explicit complementary and competitive execution modes.
- Model-tier and token-budget policy.
- Metrics, shadow mode, benchmarks, and rollback flags.

## 3.2 Deferred

- Kernel-level copy-on-write process and filesystem branching.
- General semantic merge of arbitrary concurrent source edits.
- Cross-machine distributed execution.
- Full repository-wide symbol graph for every supported language.
- Always-on real-time read-set invalidation.
- Autonomous architectural decision changes without a recorded decision event.

## 3.3 Non-goals

- Replacing Ferment with a separate project manager.
- Replacing Git as the user's source-control system.
- Exposing Git plumbing to worker prompts.
- Making every task multi-agent.
- Guaranteeing a cost reduction on every workload.
- Sharing private chain-of-thought or full worker transcripts.

# 4. Current Kimchi substrate

The implementation must extend existing mechanisms instead of creating a parallel control plane.

| Existing capability | Current location | Reuse in this plan |
|---|---|---|
| Ferment lifecycle, phases, steps, decisions, memories | `src/ferment/**` | User-facing project and task lifecycle |
| Append-only hash-chained events and snapshot fold | `src/ferment/event-store.ts` | Coordination source of truth |
| Parallel phase and step cohorts | `src/ferment/types.ts`, FSM and engine | Backward-compatible execution semantics |
| Background Agent, resume, result, steering | `src/extensions/agents/**` | Persistent task-group workers and delivery |
| Structured `AgentReport` and `AgentOutcome` | `src/extensions/agents/personas/types.ts` | Worker result and recovery integration |
| Ferment task references and spawn guard | `src/extensions/ferment/agent-spawn-guard.ts` | Prevent duplicate or premature group workers |
| Verification, judge, grades, worker budgets | `src/extensions/ferment/tools/steps.ts` | Central verification and localized retry |
| Continuation scheduler and hidden steering | `src/extensions/ferment/scheduler.ts` | Wake ready workers and orchestrator |
| LSP definitions, references, diagnostics, rename | current LSP extension | Later dependency extraction and validation |
| Phase/model telemetry | orchestration and telemetry extensions | Cost and quality evaluation |

## 4.1 Important integration decision

**Ferment remains the project lifecycle authority.** New coordination state is attached to a Ferment and persisted through the existing event-store mechanism.

Do not introduce a second authoritative SQLite database in the first milestone. The current event log already provides append-only persistence, state hashes, replay, locking, and migration behavior. A `CoordinationStore` interface should allow a SQLite projection later if query volume warrants it, but the event log remains the durable source of truth until a deliberate migration decision is recorded.

# 5. Evidence and design implications

## 5.1 External research

| Evidence | Finding | Design implication | Confidence |
|---|---|---|---|
| Claude Code Agent Teams [R1][R2] | Separate teammates consume separate contexts; costs scale with active teammates; coordination overhead and diminishing returns increase with team size. Anthropic reports about 7x token use in plan-mode teams versus standard sessions. | Keep teams small, spawn only ready work, and measure coordination tokens. | High for product behavior; vendor-specific for cost ratio |
| Co-Coder [R3] | Cohesion-aware partitioning, hub isolation, and dependency-aware scheduling improved the reported Pareto frontier over sequential and file-based baselines on 28 tasks: up to +14 percentage points pass rate, 2.10x speedup, and 35% lower API cost. | Group coupled work; isolate unstable hubs; schedule from dependencies, not file count. | Medium; recent preprint and limited benchmark set |
| PACT [R4] | Projecting agent outputs into compact public action-state records reduced token usage while maintaining or improving results; coding-harness experiments reported better tokens-per-resolved and roughly halved SWE-agent input tokens. | Handoffs must carry action, grounded state, result, and next action; never forward full reasoning by default. | Medium; recent preprint |
| Runtime-Structured Task Decomposition [R5] | Decomposition can cost more on successful runs; runtime control reduces retry cost by rerunning only failed subtasks. Reported up to 51.7% lower retry cost than monolithic and 73.2% than static decomposition. | Do not decompose merely to create agents. Persist task state and retry locally. | Medium; two evaluated workloads |
| Shepherd [R6] | Typed execution traces and sparse supervisor intervention improved reported pair-coding pass rate from 28.8% to 54.7%; replay reused prompt prefixes. | Capture structured effects and intervene only on conflicts or stalls. | Medium; research prototype |
| Jujutsu operation log and conflicts [R7][R8] | Each operation sees a consistent view; divergent operations are preserved and merged later; conflicts can remain first-class state. | Model Kimchi changes as parented operations and explicit conflicts, not mutable agent branches. | High as a systems reference |
| GitButler parallel-agent model [R9] | Multiple logical branches can share one workspace, but runtime state is shared and dependencies still need explicit stacking. | Branch/worktree layout is not enough. Explicit dependencies and resource ownership remain required. | High for documented product behavior |
| BranchFS [R10] | Copy-on-write branch contexts support fork, explore, commit or abort, and first-commit-wins for competing attempts. | Use this pattern only for competitive speculation, not normal complementary work. | Medium; research prototype |
| YoloFS [R11] | Staged mutations and snapshots allow review and self-correction of hidden side effects. | Keep execution-scope and effect-capture interfaces open for a later staged filesystem backend. | Medium; research prototype |
| BAMAS [R12] | Budget-aware model and topology selection reportedly reduced cost by up to 86% at comparable performance. | Model selection and team topology must be a budgeted runtime decision, not a fixed team template. | Medium; benchmark-specific |

## 5.2 Ecosystem scan

GitHub star counts are a popularity snapshot, not evidence of technical correctness. As observed on 2026-08-16:

| Repository | Approximate stars | Relevant capability |
|---|---:|---|
| OpenHands | 84,159 | General coding-agent platform |
| MetaGPT | 69,850 | Role- and workflow-oriented multi-agent framework |
| AutoGen | 60,444 | Agent messaging and orchestration |
| CrewAI | 57,141 | Role-based crews and flows |
| LangGraph | 39,771 | Durable graph workflows |
| Beads | 26,357 | Dependency-aware persistent task graph |
| Kimchi | 2,177 | Multi-model terminal coding harness |
| Pi Messenger | 676 | Pi messaging, tasks, dependencies, steering |
| Pi Agent Teams | 100 | Experimental Pi team/task/mailbox extension |

The popular frameworks strongly validate durable workflows, task graphs, role selection, and observability. They do not provide a widely adopted solution for complementary concurrent source operations. Kimchi therefore should reuse established orchestration ideas while keeping the source-operation layer modular and experimental.

## 5.3 Evidence-derived rules

1. Use one worker when task coupling is dense.
2. Parallelize only dependency-ready groups.
3. Publish unstable hub interfaces before starting consumers.
4. Persist public state, not private reasoning.
5. Retry only the failed group and its invalidated dependents.
6. Use strong models at partition, boundary, review, and conflict points; use smaller models for stable implementation work.
7. Treat source conflicts as data, not as an accidental terminal state.
8. Measure total cost and discarded work, not only wall-clock speed.

# 6. Architecture decisions

## AD-001: Extend Ferment instead of creating another project system

**Decision:** Attach coordination state and events to a Ferment.  
**Reason:** Ferment already owns project lifecycle, steps, replay, continuation, verification, grading, decisions, memories, and TUI state.  
**Consequence:** New code must provide adapters for existing step flows and preserve old ferments.

## AD-002: Task group is the unit of agent ownership

**Decision:** One persistent worker owns one cohesive task group, which may contain several Ferment steps.  
**Reason:** A fresh worker per file or step repeats exploration and loses useful context.  
**Consequence:** `AgentTaskRef` gains a backward-compatible task-group variant, and assignment state records the persistent agent ID.

## AD-003: Scheduling is event-driven, not wave-driven

**Decision:** Recompute readiness after every relevant event and start each group as soon as its own dependencies are satisfied.  
**Reason:** Unrelated slow work must not block ready work.  
**Consequence:** The scheduler maintains a bounded ready queue and a deterministic priority order.

## AD-004: Boundary-first execution

**Decision:** A consumer waits for a required published boundary, not necessarily for all implementation in the producer group.  
**Reason:** Serializing the smallest shared decision maximizes useful fan-out.  
**Consequence:** Boundaries have names, versions, evidence, and compatibility metadata.

## AD-005: Handoffs are Action-State-Result records

**Decision:** Cross-group communication is a validated record with a strict size budget.  
**Reason:** Free-form summaries omit state or inflate shared context.  
**Consequence:** Full transcripts remain private and are fetched only during debugging.

## AD-006: Source changes are operations, not agent branches

**Decision:** A published change records parent operation, base snapshot, file deltas, result snapshot, evidence, and conflicts.  
**Reason:** Agent identity should not be coupled to checkout layout.  
**Consequence:** Applying a change uses compare-and-swap semantics and can create a durable conflict.

## AD-007: Complementary and competitive execution are separate modes

**Decision:** Complementary groups produce results that all must compose. Competitive attempts produce alternatives and only one winner is accepted.  
**Reason:** First-commit-wins is appropriate for alternatives, not for backend + frontend + tests.  
**Consequence:** Competitive execution is deferred until an execution-scope backend exists.

## AD-008: Existing event log is initially authoritative

**Decision:** Add coordination events to Ferment's hash-chained JSONL log. SQLite, if added, is a projection or later migration.  
**Reason:** Two authoritative stores would create recovery and consistency problems before the feature proves value.  
**Consequence:** Event payloads reference large artifacts stored separately.

## AD-009: Read invalidation is a fallback

**Decision:** Normal coordination uses declared dependencies and boundaries. Read/write overlap detection is used for unexpected changes or safety checks.  
**Reason:** Tracking and invalidating every read creates noise, extra reasoning, and lost parallelism.  
**Consequence:** The first version tracks declared resource scopes and boundary consumption; symbol-level observation is added later.

## AD-010: Roll out through shadow mode

**Decision:** Compute groups, readiness, and predicted savings without changing execution before enabling parallel workers.  
**Reason:** We need workload-specific evidence.  
**Consequence:** Every milestone includes comparison metrics and a kill switch.

# 7. Domain model

## 7.1 Core entities

| Entity | Meaning |
|---|---|
| `TaskGroup` | Cohesive steps owned by one persistent worker |
| `TaskDependency` | Hard, boundary, or advisory relationship between groups |
| `PublishedBoundary` | Versioned public interface or decision that consumers can rely on |
| `AgentAssignment` | Persistent mapping from a task group to an Agent session |
| `SourceSnapshot` | Immutable identity for the source state observed by an operation |
| `ChangeOperation` | Published source delta with parentage, evidence, and result snapshot |
| `HandoffRecord` | Compact public state update for direct dependents |
| `ResourceClaim` | Declared file, symbol, command, or runtime resource ownership |
| `ConflictRecord` | Durable unresolved incompatibility between operations or boundaries |
| `VerificationRun` | Centralized test or judge evidence tied to an operation and group |
| `RepairRequest` | Localized follow-up assigned to the group that owns the failure |

## 7.2 Task dependency kinds

### Hard dependency

The downstream group cannot start until the upstream group is complete.

Examples:

- generate a migration before running migration-specific query updates;
- add a compiler plugin before consuming its generated output.

### Boundary dependency

The downstream group waits only for a named boundary version.

Examples:

- publish `AuthenticationSession` version 2 before client and validation work;
- publish a database schema decision before repository implementations.

This is the default for contract-first fan-out.

### Advisory dependency

The downstream group may run without the upstream result. A later handoff is routed only if relevant.

Examples:

- documentation research that may improve an implementation;
- a performance experiment that is not required for correctness.

Advisory dependencies never trigger automatic abort or restart. A breaking boundary change may steer an active consumer, but ordinary implementation detail does not.

## 7.3 Task group state

```text
planned
    -> ready
    -> running
    -> verifying
    -> completed

planned/running/verifying
    -> blocked
    -> ready

running/verifying
    -> failed
    -> repair_requested
    -> ready

any non-terminal state
    -> cancelled
```

State transitions must be deterministic and event-sourced. The scheduler may suggest actions, but only the state machine mutates state.

# 8. End-to-end example

User request:

```text
Change session expiry from integer seconds to optional Date,
update the HTTP client and validation,
and add regression tests.
```

## 8.1 Planned groups

```text
Group: session-boundary
  - decide public type and null semantics
  - publish AuthenticationSession version 2

Group: session-model
  - parser and model implementation
  depends on: AuthenticationSession version 2

Group: http-client
  - update client call sites
  depends on: AuthenticationSession version 2

Group: validation
  - update expiry validation
  depends on: AuthenticationSession version 2

Group: regression-tests
  - map current coverage and add end-to-end tests
  advisory dependency on session-boundary during discovery
  hard dependency on completed implementation before final verification
```

## 8.2 Runtime path

```text
session-boundary starts first
regression-tests may perform read-only discovery in parallel

session-boundary publishes:
  AuthenticationSession v2
  ExpiresAt: Date | null
  null means no expiry
  comparisons use UTC

scheduler immediately releases:
  session-model
  http-client
  validation

three persistent workers run in parallel
regression-tests receives the boundary and finishes implementation-specific tests

central verifier runs the authentication and client suites
failure in HTTP client creates a repair request only for http-client group
```

## 8.3 Handoff example

```yaml
action: publish_boundary
state:
  facts:
    - AuthenticationSession.ExpiresAt is Date | null.
    - null means no expiry.
    - All comparisons use UTC.
  evidence:
    - src/auth/session.ts
    - src/auth/session.test.ts
result:
  operation_id: operation-0184
  boundaries:
    - name: AuthenticationSession
      version: 2
      compatibility: breaking
next:
  unblocked_task_groups:
    - session-model
    - http-client
    - validation
```

The handoff does not include the producer's full transcript, discarded options, or chain-of-thought.

# 9. Proposed module layout

The core engine should be independent of the TUI and Ferment extension APIs.

```text
src/coordination/
  types.ts
  events.ts
  reducer.ts
  plan-validator.ts
  readiness.ts
  scheduler.ts
  priority.ts
  handoff.ts
  resource-claims.ts
  metrics.ts
  partition/
    graph.ts
    signals.ts
    partitioner.ts
  source/
    types.ts
    blob-store.ts
    filesystem-cas-blob-store.ts
    snapshot.ts
    operation-capture.ts
    operation-apply.ts
    conflicts.ts

src/extensions/ferment/
  coordination-adapter.ts
  coordination-runtime.ts
  coordination-prompt.ts
  coordination-renderer.ts
  tools/coordination.ts

src/extensions/agents/
  manager/group-assignment.ts
  personas/types.ts                 # backward-compatible task ref/report additions

benchmark/coordination/
  fixtures/
  runner.ts
  metrics.ts
```

Tests remain colocated as `*.test.ts` per repository guidelines.

# 10. Prototype TypeScript interfaces

## 10.1 Coordination state

```typescript
// src/coordination/types.ts

export type TaskGroupStatus =
  | "planned"
  | "ready"
  | "running"
  | "blocked"
  | "verifying"
  | "repair_requested"
  | "completed"
  | "failed"
  | "cancelled"

export type ExecutionMode = "complementary" | "competitive"

export interface TaskGroup {
  id: string
  fermentId: string
  title: string
  description: string
  stepIds: string[]
  status: TaskGroupStatus
  executionMode: ExecutionMode
  expectedReads: ResourceSelector[]
  expectedWrites: ResourceSelector[]
  consumesBoundaries: BoundaryRequirement[]
  producesBoundaries: BoundaryDeclaration[]
  risk: "low" | "medium" | "high"
  estimatedTokens?: number
  estimatedDurationMs?: number
  assignedAgentId?: string
  createdAt: string
  updatedAt: string
}

export type DependencyKind = "hard" | "boundary" | "advisory"

export interface TaskDependency {
  id: string
  fermentId: string
  upstreamGroupId: string
  downstreamGroupId: string
  kind: DependencyKind
  boundary?: BoundaryRequirement
  reason: string
}

export interface BoundaryRequirement {
  name: string
  minimumVersion: number
}

export interface BoundaryDeclaration {
  name: string
  compatibility: "compatible" | "breaking" | "unknown"
}

export interface ResourceSelector {
  kind: "file_glob" | "symbol" | "command" | "runtime"
  value: string
  access: "read" | "write" | "exclusive"
}

export interface CoordinationState {
  version: 1
  fermentId: string
  taskGroups: Record<string, TaskGroup>
  dependencies: Record<string, TaskDependency>
  boundaries: Record<string, PublishedBoundary>
  assignments: Record<string, AgentAssignment>
  operationRefs: Record<string, ChangeOperationRef>
  handoffRefs: Record<string, HandoffRecordRef>
  conflicts: Record<string, ConflictRecord>
  verificationRuns: Record<string, VerificationRun>
  revision: number
}
```

## 10.2 Backward-compatible agent task references

```typescript
// src/extensions/agents/personas/types.ts

export type AgentTaskRef =
  | {
      kind: "ferment_step"
      ferment_id: string
      phase_id: string
      step_id: string
      budget_tier?: FermentWorkerBudgetTier
    }
  | {
      kind: "ferment_task_group"
      ferment_id: string
      task_group_id: string
      active_step_id?: string
      budget_tier?: FermentWorkerBudgetTier
    }
```

Existing step references continue to work. New task-group references allow one worker session to own several steps.

## 10.3 Structured handoff

```typescript
// src/coordination/handoff.ts

export interface HandoffRecord {
  id: string
  fermentId: string
  producerGroupId: string
  producerAgentId: string
  action: string
  state: {
    facts: string[]
    evidence: EvidenceRef[]
    assumptions?: string[]
    risks?: string[]
  }
  result: {
    operationId?: string
    boundaries?: PublishedBoundaryRef[]
    artifacts?: ArtifactRef[]
    verification?: VerificationSummary[]
  }
  next: {
    unblockedTaskGroupIds: string[]
    requiredActions?: string[]
  }
  createdAt: string
}

export function validateHandoff(handoff: HandoffRecord): string[] {
  const errors: string[] = []
  if (!handoff.action.trim()) errors.push("action is required")
  if (handoff.state.facts.length === 0) errors.push("at least one state fact is required")
  if (!handoff.result.operationId && !handoff.result.boundaries?.length && !handoff.result.artifacts?.length) {
    errors.push("result must reference an operation, boundary, or artifact")
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(handoff), "utf8")
  if (serializedBytes > 16_384) errors.push("handoff exceeds 16 KiB public-state budget")
  return errors
}
```

The 16 KiB limit is an upper safety bound. The runtime should target substantially smaller handoffs and record serialized token estimates.

## 10.4 Coordination event envelope

Rather than adding dozens of top-level Ferment event types, add one backward-compatible envelope whose payload is a nested discriminated union.

```typescript
// src/coordination/events.ts

export type CoordinationEvent =
  | { type: "plan_created"; payload: CoordinationPlanCreated }
  | { type: "task_group_ready"; payload: TaskGroupReady }
  | { type: "task_group_started"; payload: TaskGroupStarted }
  | { type: "task_group_blocked"; payload: TaskGroupBlocked }
  | { type: "task_group_completed"; payload: TaskGroupCompleted }
  | { type: "agent_assigned"; payload: AgentAssigned }
  | { type: "boundary_published"; payload: BoundaryPublished }
  | { type: "handoff_published"; payload: HandoffPublished }
  | { type: "change_operation_published"; payload: ChangeOperationPublished }
  | { type: "conflict_recorded"; payload: ConflictRecorded }
  | { type: "verification_recorded"; payload: VerificationRecorded }
  | { type: "repair_requested"; payload: RepairRequested }

export interface CoordinationEventEnvelope {
  type: "coordination_event"
  payload: CoordinationEvent
}
```

The Ferment snapshot gains an optional `coordination?: CoordinationState`. Old event logs and snapshots remain valid.

## 10.5 Store interface

```typescript
// src/coordination/store.ts

export interface CoordinationStore {
  load(fermentId: string): Promise<CoordinationState | undefined>

  append(
    fermentId: string,
    expectedRevision: number,
    event: CoordinationEvent,
  ): Promise<{ state: CoordinationState; eventId: string }>

  listEvents(
    fermentId: string,
    afterRevision?: number,
  ): Promise<readonly PersistedCoordinationEvent[]>
}
```

The first adapter appends through `FermentEventStore` while holding its existing lock. A later SQLite implementation may materialize projections, but it must preserve event ordering and revision compare-and-swap.

# 11. Planning and cohesion

## 11.1 First version: planner-declared groups with deterministic validation

Do not begin with automatic repository community detection. First make the planner produce explicit groups, dependencies, boundaries, and resource scopes. Then validate them.

Planner output:

```yaml
task_groups:
  - id: session-boundary
    steps: [step-1]
    produces:
      - name: AuthenticationSession
        compatibility: breaking
    expected_writes:
      - src/auth/session.ts

  - id: http-client
    steps: [step-2]
    consumes:
      - name: AuthenticationSession
        minimum_version: 2
    expected_writes:
      - src/client/**

dependencies:
  - upstream: session-boundary
    downstream: http-client
    kind: boundary
    boundary:
      name: AuthenticationSession
      minimum_version: 2
```

Deterministic validation rejects or repairs:

- missing step ownership;
- one step assigned to several complementary groups;
- cycles in hard/boundary dependencies;
- parallel groups with overlapping exclusive write claims;
- consumers of undeclared boundaries;
- competitive mode mixed with complementary dependents;
- more groups than the worker limit without a queue;
- tiny groups that are cheaper to keep together.

## 11.2 Later version: repository-derived coupling signals

After the runtime and metrics exist, add deterministic signals:

1. Declared overlapping writes.
2. TypeScript import graph.
3. LSP symbol references.
4. Test-to-source overlap.
5. Generated-file ownership.
6. Package and module boundaries.
7. Git co-change history.
8. Runtime conflict and cross-group-message history.

Suggested coupling weights for an experiment, not a permanent contract:

```typescript
export function couplingScore(left: WorkItem, right: WorkItem): number {
  let score = 0
  if (overlaps(left.expectedWrites, right.expectedWrites)) score += 100
  if (sharesUnstableBoundary(left, right)) score += 40
  score += 10 * sharedReferencedSymbols(left, right)
  score += 6 * sharedTests(left, right)
  score += 4 * importEdgesBetween(left, right)
  score += 2 * historicalCochangeCount(left, right)
  return score
}
```

The hard rule is more important than the exact weights:

```text
High communication or repeated conflicts between two groups
    -> merge them for the next run or remaining work
```

## 11.3 Hub isolation

A hub is a resource with high fan-out or fan-in, such as a public type, schema, shared configuration, generated API, or central registry.

The planner should create a small hub group that publishes the boundary before consumer implementation starts. Internal hub implementation may continue after publication if the public boundary is stable.

# 12. Event-driven scheduler

## 12.1 Readiness rule

A task group is ready when:

- it is `planned`, `blocked`, or `repair_requested`;
- every hard dependency is complete;
- every boundary dependency has a compatible published version;
- no unresolved conflict blocks its expected writes;
- its exclusive resource claims do not overlap a running group;
- the worker and token budgets permit another active group.

## 12.2 No global waves

After any of these events, recompute readiness:

- group completed;
- boundary published;
- conflict resolved;
- resource claim released;
- worker stopped;
- repair request created;
- user approval recorded.

A slow unrelated group never blocks a newly ready group.

## 12.3 Deterministic priority

```typescript
// src/coordination/priority.ts

export function priorityScore(group: TaskGroup, graph: TaskGraph): number {
  const criticalPath = graph.remainingCriticalPathWeight(group.id)
  const unlockCount = graph.directBlockedDependents(group.id).length
  const boundaryBonus = group.producesBoundaries.length > 0 ? 50 : 0
  const repairBonus = group.status === "repair_requested" ? 25 : 0
  const riskPenalty = group.risk === "high" ? 10 : 0
  return criticalPath * 10 + unlockCount * 5 + boundaryBonus + repairBonus - riskPenalty
}
```

Ties use stable IDs so replay produces the same decision.

## 12.4 Scheduler prototype

```typescript
// src/coordination/scheduler.ts

export interface SchedulerDecision {
  ready: string[]
  start: string[]
  blocked: Array<{ groupId: string; reasons: string[] }>
}

export function schedule(
  state: CoordinationState,
  limits: { maxWorkers: number; maxEstimatedTokens: number },
): SchedulerDecision {
  const running = Object.values(state.taskGroups).filter((group) => group.status === "running")
  const capacity = Math.max(0, limits.maxWorkers - running.length)

  const candidates = Object.values(state.taskGroups)
    .filter((group) => ["planned", "blocked", "repair_requested"].includes(group.status))
    .map((group) => ({ group, reasons: readinessBlockers(state, group) }))

  const ready = candidates
    .filter((candidate) => candidate.reasons.length === 0)
    .map((candidate) => candidate.group)
    .sort((left, right) => priorityScore(right, stateGraph(state)) - priorityScore(left, stateGraph(state)))

  return {
    ready: ready.map((group) => group.id),
    start: ready.slice(0, capacity).map((group) => group.id),
    blocked: candidates
      .filter((candidate) => candidate.reasons.length > 0)
      .map((candidate) => ({ groupId: candidate.group.id, reasons: candidate.reasons })),
  }
}
```

The scheduler is pure. The Ferment adapter performs state transitions, Agent calls, steering, and persistence.

# 13. Persistent task-group workers

## 13.1 Assignment lifecycle

```text
ready group has no assignment
    -> spawn Agent with ferment_task_group task reference
    -> persist agent_assigned

ready group has an idle/resumable assignment
    -> resume_subagent with next step and current handoffs

assigned worker is running
    -> do not spawn a duplicate

worker fails or exhausts budget
    -> inspect structured report
    -> resume same worker when continuation is coherent
    -> otherwise spawn a replacement linked to the same group
```

## 13.2 Context given to a group worker

A group worker receives:

- Ferment charter and group goal;
- owned steps;
- allowed write and exclusive resource scopes;
- published boundaries it consumes;
- direct upstream handoffs;
- current canonical operation ID;
- relevant decisions and memories;
- required verification;
- explicit completion and report schema.

It does not receive:

- unrelated group transcripts;
- the complete event log;
- all team messages;
- private reasoning from upstream workers.

## 13.3 Report extension

Keep the existing `AgentReport` fields. Add optional public outputs:

```typescript
export interface AgentReport {
  // existing fields remain
  public_handoff_id?: string
  draft_operation_id?: string
  published_boundaries?: Array<{ name: string; version: number }>
  unresolved_conflict_ids?: string[]
}
```

The host assigns IDs. Workers cannot invent successful operation or handoff records merely by writing strings into a report.

# 14. Source snapshots and change operations

## 14.1 Principle

A source operation is a durable statement:

```text
Starting from source snapshot 17,
this task group changed these resources,
producing source snapshot 18,
with this verification evidence.
```

It is not:

```text
Agent GreenFalcon owns branch green-falcon-2.
```

## 14.2 File-level operation model

```typescript
// src/coordination/source/types.ts

export interface SourceSnapshot {
  id: string
  repositoryHeadOid?: string
  parentOperationIds: string[]
  files: Record<string, SourceFileVersion>
  createdAt: string
}

export interface SourceFileVersion {
  path: string
  contentSha256: string | null
  blobRef?: string
  mode?: number
}

export interface FileChange {
  path: string
  kind: "add" | "modify" | "delete" | "rename"
  before: SourceFileVersion | null
  after: SourceFileVersion | null
  patchRef?: string
  renamedFrom?: string
}

export interface ChangeOperation {
  id: string
  fermentId: string
  taskGroupId: string
  agentId: string
  parentOperationIds: string[]
  baseSnapshotId: string
  resultSnapshotId: string
  changes: FileChange[]
  handoffId?: string
  verificationRunIds: string[]
  status: "draft" | "published" | "applied" | "conflicted" | "rejected"
  createdAt: string
  publishedAt?: string
}
```

## 14.3 Content-addressed artifacts

Large file contents and patches do not belong in the Ferment event line. Introduce:

```typescript
export interface BlobStore {
  put(content: Uint8Array): Promise<{ ref: string; sha256: string }>
  get(ref: string): Promise<Uint8Array>
  has(ref: string): Promise<boolean>
}
```

MVP backend:

```text
.kimchi/ferments/<ferment-id>/coordination/blobs/<sha256>
.kimchi/ferments/<ferment-id>/coordination/operations/<operation-id>.json
.kimchi/ferments/<ferment-id>/coordination/handoffs/<handoff-id>.json
```

This directory is runtime state and remains uncommitted. A later backend may store blobs in Git's object database or a remote artifact service after retention and garbage-collection semantics are defined.

## 14.4 Capture

For the first implementation:

1. Capture hashes for the group's declared write scope when it starts.
2. Run the worker only if its write scope is compatible with other running groups.
3. Capture hashes and content after the worker finishes.
4. Create file deltas.
5. Reject undeclared writes or convert them into a conflict requiring approval.
6. Publish the operation only after worker report validation.

This does not require every file read to be tracked.

## 14.5 Apply with compare-and-swap

```typescript
// src/coordination/source/operation-apply.ts

export async function applyOperation(
  operation: ChangeOperation,
  workspace: Workspace,
  blobs: BlobStore,
): Promise<{ applied: true } | { applied: false; conflict: ConflictRecord }> {
  const mismatches: FileVersionMismatch[] = []

  for (const change of operation.changes) {
    const current = await workspace.version(change.path)
    const expected = change.before?.contentSha256 ?? null
    if (current.contentSha256 !== expected) {
      mismatches.push({ path: change.path, expected, actual: current.contentSha256 })
    }
  }

  if (mismatches.length > 0) {
    return {
      applied: false,
      conflict: createSourceConflict(operation, mismatches),
    }
  }

  await workspace.atomicBatch(async (batch) => {
    for (const change of operation.changes) {
      if (change.kind === "delete") {
        await batch.delete(change.path)
        continue
      }
      if (!change.after?.blobRef) throw new Error(`missing blob for ${change.path}`)
      await batch.write(change.path, await blobs.get(change.after.blobRef), change.after.mode)
    }
  })

  return { applied: true }
}
```

A mismatch does not silently merge. It creates a `ConflictRecord` that may be routed to the owning group, a dedicated resolver, or a strong model.

## 14.6 Conflict record

```typescript
export interface ConflictRecord {
  id: string
  fermentId: string
  kind: "source" | "boundary" | "resource" | "verification"
  operationIds: string[]
  taskGroupIds: string[]
  resources: string[]
  summary: string
  detailsRef?: string
  status: "open" | "resolving" | "resolved" | "waived"
  resolutionOperationId?: string
  createdAt: string
  resolvedAt?: string
}
```

Conflicts remain inspectable and replayable. They do not become arbitrary text in a subagent's output.

# 15. Resource ownership and side effects

## 15.1 MVP safety policy

Parallel complementary builders are allowed only when expected write scopes and exclusive resources are disjoint.

Examples of exclusive resources:

- `git-index`
- `dependency-install`
- `package-lock`
- `code-generation:<generator-name>`
- `database-migration-order`
- `shared-dev-server`

A group may read another group's files. It may not write outside its declared scope without publishing a deviation event.

## 15.2 Tool interception

Use Kimchi extension hooks to observe:

- `read`, `lsp_definition`, and `lsp_references` for optional telemetry;
- `edit`, `write`, and patch tools for declared-write enforcement;
- `bash` for command resource classification and pre/post scope scans.

The first release should block clear write-scope violations and record ambiguous shell side effects. It should not attempt a complete syscall-level filesystem model.

## 15.3 Execution-scope abstraction

```typescript
export interface ExecutionScope {
  id: string
  baseSnapshotId: string
  cwd: string
  checkpoint(): Promise<SourceSnapshot>
  captureOperation(): Promise<ChangeOperation>
  discard(): Promise<void>
}

export interface ExecutionScopeFactory {
  create(request: ExecutionScopeRequest): Promise<ExecutionScope>
}
```

Initial complementary mode may use a guarded shared workspace for disjoint writers. Later implementations can add staged or copy-on-write materializers. The agent-facing model remains `ExecutionScope`, never a worktree path.

The existing worktree isolation feature remains available for unrelated legacy use and explicit competitive attempts, but it is not used as task identity or persisted coordination semantics.

# 16. Communication and delivery

## 16.1 Automatic messages

The harness generates messages for:

- a required boundary becoming available;
- a direct dependency completing;
- a task group becoming ready;
- a conflict affecting the recipient;
- verification failure owned by the recipient;
- approval or user input becoming available.

## 16.2 Explicit peer questions

Workers may ask focused questions such as:

```text
Does AuthenticationSession v2 intentionally distinguish missing expiry from unlimited expiry?
```

The question and answer are persisted as a decision or boundary clarification if they affect public state. Casual team chat is not injected into every context.

## 16.3 Delivery policy

- Idle assigned worker: resume with the new handoff.
- Running worker with non-breaking advisory input: queue until next safe turn.
- Running worker with breaking boundary conflict: steer after current tool call and mark group blocked.
- Crashed worker: include unread handoffs during recovery.
- Future group not yet spawned: include handoffs in initial prompt.

## 16.4 Message relevance

Recipients are determined from:

1. direct task dependencies;
2. boundary consumers;
3. resource-conflict participants;
4. explicit decision participants;
5. human-selected recipients.

Do not broadcast normal operation completion to all workers.

# 17. Verification and localized repair

## 17.1 Central verification

Workers may run focused tests. Canonical acceptance tests run after operations are applied to the canonical source state.

A verification record contains:

```typescript
export interface VerificationRun {
  id: string
  fermentId: string
  taskGroupId?: string
  operationIds: string[]
  command: string
  exitCode: number
  stdoutRef?: string
  stderrRef?: string
  durationMs: number
  classification: "pass" | "retry" | "fail" | "inconclusive"
  createdAt: string
}
```

## 17.2 Failure routing

When verification fails:

1. Attribute likely ownership using changed files, test scope, and task-group claims.
2. Create one or more `RepairRequest` records.
3. Reopen only the owning group unless evidence shows a boundary or upstream defect.
4. Resume the existing worker when its context remains useful.
5. Escalate model tier after bounded repeated failure.
6. Do not rerun unrelated completed groups.

## 17.3 Repair request

```typescript
export interface RepairRequest {
  id: string
  fermentId: string
  taskGroupId: string
  verificationRunId: string
  failingTests: string[]
  suspectedResources: string[]
  evidenceRefs: string[]
  attempt: number
  modelEscalation?: "none" | "standard" | "heavy"
  status: "open" | "running" | "resolved" | "abandoned"
}
```

# 18. Model and budget policy

## 18.1 Recommended role split

| Work | Default model tier |
|---|---|
| Initial partition and boundary review | Heavy reasoning |
| Deterministic graph validation and scheduling | No model |
| Stable cohesive implementation group | Light or standard builder |
| Mechanical tests and call-site updates | Light builder |
| Normal independent review | Standard reviewer |
| Cross-group conflict or repeated repair | Heavy reasoning/reviewer |
| Handoff projection | Small structured-output model or deterministic template |

## 18.2 Smaller-model benefit

Smaller workers should perform better because they receive:

- one cohesive responsibility;
- stable boundary versions;
- only direct upstream state;
- explicit allowed resources;
- exact verification commands;
- a constrained completion schema.

The harness removes these burdens from the worker:

- discovering every teammate;
- interpreting a shared feed;
- guessing whether a patch matters;
- choosing Git integration commands;
- reconciling several designs unaided.

This does not make a weak model capable of every architectural task. The runtime must escalate when risk, conflict, or repeated failure crosses configured thresholds.

## 18.3 Budget guard

Before spawning another worker, estimate:

```text
expected critical-path time saved
    versus
new worker context cost
+ expected handoff cost
+ verification cost
+ predicted repair and discard cost
```

The first implementation can use conservative heuristics:

- never exceed configured `maxWorkers`;
- require at least two non-trivial ready groups;
- do not split groups below a minimum estimated token budget;
- keep high-coupling groups together;
- use one worker when predicted communication cost exceeds predicted parallel savings.

# 19. Settings and feature flags

Proposed settings:

```json
{
  "coordination": {
    "enabled": false,
    "shadowPlan": true,
    "maxWorkers": 3,
    "maxEstimatedActiveTokens": 120000,
    "handoffProtocol": "action-state-result-v1",
    "sourceOperations": false,
    "resourceClaims": "warn",
    "supervisor": {
      "enabled": false,
      "model": "role:reviewer",
      "interventionBudget": 3
    }
  }
}
```

Rollout order:

1. `shadowPlan: true`, no execution changes.
2. Enable structured handoffs for sequential groups.
3. Enable event-driven scheduling for read-only and disjoint-write groups.
4. Enable source operations in warning mode.
5. Enable compare-and-swap conflict blocking.
6. Enable automatic cohesion suggestions.
7. Enable sparse supervisor only for high-risk runs.

A single environment or settings switch must return Kimchi to current Ferment behavior.

# 20. User and TUI experience

## 20.1 Ferment progress view

Add a task-group layer without removing phase/step navigation:

```text
Phase 2: Authentication update

Task groups
  [running] session-model       agent: CedarFox    step 2/3
  [running] http-client         agent: AmberLake   step 1/2
  [blocked] validation          waiting: AuthenticationSession v2
  [ready]   regression-tests    queued by worker budget

Published boundaries
  AuthenticationSession v2 (breaking)

Open conflicts
  none
```

## 20.2 Commands

Suggested commands:

```text
/ferment graph
/ferment groups
/ferment operations
/ferment conflicts
/ferment metrics
/ferment coordination on|off|shadow
```

Tool APIs for agents:

```text
publish_task_group_handoff
publish_boundary
publish_change_operation
report_coordination_conflict
resolve_coordination_conflict
get_task_group_context
get_ready_task_groups
```

The orchestrator remains responsible for lifecycle transitions. Workers publish evidence and reports but cannot mark arbitrary groups complete.

# 21. Persistence and recovery

## 21.1 Event source

Add a `coordination_event` envelope to `FermentEvent`. The fold updates `Ferment.coordination`.

Large operation, blob, handoff, stdout, and stderr artifacts are referenced by ID and checksum.

## 21.2 Concurrency

Appending a coordination event must:

1. acquire the existing Ferment event-store lock;
2. load the latest state;
3. verify expected coordination revision;
4. apply the event through a pure reducer;
5. append the event and update snapshot;
6. release the lock;
7. notify the in-process scheduler.

Stale writers receive a revision conflict and must reload. They do not overwrite newer state.

## 21.3 Recovery

On startup or session resume:

1. fold Ferment and coordination events;
2. validate referenced artifacts and checksums;
3. mark assignments with missing Agent sessions as recoverable;
4. recompute ready groups;
5. requeue unresolved handoffs;
6. preserve open conflicts;
7. continue according to Ferment continuation policy.

## 21.4 Optional SQLite projection

SQLite is useful later for queries such as resource overlap, metrics, and cross-run learning. It should begin as a rebuildable projection:

```sql
CREATE TABLE task_group_projection (
  ferment_id TEXT NOT NULL,
  task_group_id TEXT NOT NULL,
  status TEXT NOT NULL,
  assigned_agent_id TEXT,
  revision INTEGER NOT NULL,
  PRIMARY KEY (ferment_id, task_group_id)
);

CREATE TABLE dependency_projection (
  ferment_id TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  upstream_group_id TEXT NOT NULL,
  downstream_group_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  boundary_name TEXT,
  minimum_boundary_version INTEGER,
  PRIMARY KEY (ferment_id, dependency_id)
);

CREATE TABLE operation_projection (
  ferment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  task_group_id TEXT NOT NULL,
  base_snapshot_id TEXT NOT NULL,
  result_snapshot_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ferment_id, operation_id)
);
```

The projection can be deleted and rebuilt from events. It must not become a second untracked source of truth.

# 22. Implementation phases

## Phase 0: Baseline and shadow instrumentation

**Goal:** Know whether the new design helps before changing execution.

Deliverables:

- coordination settings and kill switch;
- run metrics schema;
- baseline runner comparing single-agent and current parallel behavior;
- shadow planner that records proposed groups and dependencies;
- no worker-spawn behavior changes.

Exit criteria:

- baseline data from at least five representative Kimchi tasks;
- deterministic metric export;
- no visible behavior change when feature is disabled;
- shadow plan can be inspected from CLI/TUI or exported JSON.

## Phase 1: Task groups, dependencies, handoffs, and scheduler

**Goal:** Ship the main orchestration improvement without solving filesystem transactions.

Deliverables:

- core coordination types and reducer;
- Ferment event envelope and snapshot integration;
- planner schema and deterministic validator;
- event-driven ready queue;
- persistent task-group assignments;
- Action-State-Result handoffs;
- direct-dependent delivery;
- disjoint-write resource checks;
- central verification and localized repair integration;
- TUI and E2E tests.

Exit criteria:

- unrelated ready groups start without waiting for global waves;
- a boundary publication immediately unblocks direct consumers;
- one group reuses one Agent session across multiple steps;
- no duplicate worker can be spawned for the same active group;
- failed verification reopens only attributed groups;
- event replay produces identical coordination state.

## Phase 2: Source snapshots, operations, and conflicts

**Goal:** Make source changes first-class and remove branch/worktree semantics from coordination.

Deliverables:

- content-addressed blob store;
- declared-scope snapshot capture;
- change-operation creation;
- compare-and-swap apply;
- durable conflict records;
- operation inspection tools;
- undeclared-write detection;
- operation and conflict UI.

Exit criteria:

- operations can be captured and replayed without agent branch identity;
- stale file versions create conflicts instead of silent overwrite;
- operation artifacts survive session restart;
- canonical verification references exact operation IDs.

## Phase 3: Cohesion analysis and planner assistance

**Goal:** Improve grouping quality using repository evidence.

Deliverables:

- TypeScript import graph;
- LSP symbol-reference extraction;
- test overlap signals;
- hub detection;
- grouping recommendations and confidence;
- shadow comparison against planner-only grouping;
- feedback from conflicts and handoff volume.

Exit criteria:

- grouping recommendations are deterministic for the same repository state;
- recommendations never create write-overlap violations;
- benchmark shows improved or neutral pass rate and better cost/latency frontier;
- low-confidence partitions fall back to one group or planner review.

## Phase 4: Execution scopes and competitive mode

**Goal:** Safely support incompatible runtime state and alternative attempts.

Deliverables:

- `ExecutionScope` interface;
- staged or copy-on-write feasibility prototype;
- process and filesystem side-effect capture;
- competitive fork-explore-select flow;
- winner verification and loser discard;
- resource and cleanup guarantees.

Exit criteria:

- competitive attempts cannot modify canonical state before selection;
- committing one winner is atomic from the harness perspective;
- discarded attempts leave no untracked process or file effects;
- complementary mode remains unchanged.

## Phase 5: Sparse supervision and adaptive regrouping

**Goal:** Use a strong model only when deterministic signals show a problem.

Intervention triggers:

- overlapping write intent;
- unexpected breaking boundary change;
- repeated verification failure;
- stalled worker;
- high cross-group message volume;
- unresolved source conflict;
- user-defined high-risk action.

Allowed interventions:

- inject focused guidance;
- request boundary clarification;
- merge task groups;
- hand off state to another worker;
- change model tier;
- discard a competitive scope;
- escalate to user approval.

Exit criteria:

- intervention count is bounded and observable;
- supervisor is not invoked on ordinary successful groups;
- adaptive merging reduces repeated cross-group communication;
- total cost is compared against no-supervisor baseline.

# 23. Testing strategy

## 23.1 Unit tests

Every pure module has colocated tests:

- event reducer and revision checks;
- cycle and plan validation;
- resource selector overlap;
- readiness and priority;
- handoff schema and size limits;
- operation capture and apply;
- conflict creation and resolution;
- metric aggregation.

Property tests should cover:

- event replay determinism;
- scheduler determinism;
- no ready group with unsatisfied hard/boundary dependencies;
- no simultaneous exclusive-resource ownership;
- operation apply never overwrites a mismatched base;
- resolved conflicts reference a resolution operation.

## 23.2 Integration tests

Scenarios:

1. Two independent groups start concurrently.
2. Hard-dependent group waits for completion.
3. Boundary-dependent groups start immediately after publication.
4. Advisory result arrives after consumer starts without forcing restart.
5. One persistent worker handles several group steps.
6. Worker exhausts budget and resumes from structured report.
7. Worker crashes and assignment recovers after session restart.
8. Duplicate Agent spawn is blocked.
9. Resource overlap prevents unsafe parallel start.
10. Source operation applies when hashes match.
11. Source operation produces conflict when hashes differ.
12. Verification failure creates localized repair.
13. Malformed or oversized handoff is rejected.
14. Event log concurrent append produces one ordered state.
15. Feature-disabled path matches current behavior.

## 23.3 TUI E2E tests

Human-recognizable workflows under `tests/e2e/tui`:

- view task-group progress and blockers;
- publish a boundary and see consumers become ready;
- inspect an operation and conflict;
- disable coordination and return to current Ferment execution;
- resume a crashed multi-group Ferment.

Follow existing TUI fixture rules: deterministic fake responses, isolated HOME/workdir, clear user-visible checkpoints, and no brittle ANSI snapshots unless rendering itself is under test.

# 24. Benchmark and success metrics

## 24.1 Compared modes

Run the same task suite in:

1. single orchestrator/worker;
2. current Ferment parallel cohorts;
3. new planner-declared task groups and scheduler;
4. new scheduler plus source operations;
5. later cohesion-assisted grouping.

Use fixed model configurations and at least 10 runs for stable comparison where cost permits.

## 24.2 Required metrics

### Correctness

- task success rate;
- required tests passing;
- Ferment grades and deltas;
- number of regressions after integration.

### Latency

- total wall-clock duration;
- critical-path duration;
- ready-queue wait;
- worker utilization;
- verification and repair duration.

### Cost

- input, output, cache-read, and cache-write tokens;
- estimated monetary cost;
- cost by model role and task group;
- handoff projection cost;
- supervisor cost.

### Waste

- duplicate file reads across workers;
- public handoff bytes/tokens;
- number of cross-group questions;
- discarded operations;
- repair tokens;
- repeated verification;
- time spent blocked;
- operations rejected by version mismatch.

### Partition quality

- groups merged at runtime;
- resource conflicts;
- boundary changes after consumer start;
- communication-to-implementation token ratio;
- accepted changes per active worker.

## 24.3 Initial rollout thresholds

The feature should not become default unless the internal benchmark demonstrates:

- no material correctness regression;
- at least 20% median wall-clock improvement on tasks classified as parallelizable;
- no more than 10% median token increase, or a documented quality improvement that justifies it;
- less than 10% discarded worker work;
- public handoff tokens below 5% of total tokens;
- deterministic recovery from restart and event replay.

Thresholds are provisional and must be revised from actual data, not defended out of emotional attachment to a diagram.

# 25. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Planner creates poor groups | Duplicate work or hidden dependency | Deterministic validation, shadow mode, cohesion signals, runtime merge |
| Event schema bloats Ferment | Migration and maintenance cost | One event envelope, optional snapshot state, artifact references |
| Shared workspace side effects | Flaky tests or hidden interference | Disjoint write claims, exclusive command resources, centralized verification, later execution scopes |
| Handoffs omit crucial state | Downstream mistakes | Required facts/evidence/result fields, schema validation, boundary versioning |
| Too many agents increase cost | Economic regression | Bounded workers, minimum group size, cost telemetry, single-agent fallback |
| Persistent worker drifts | Reuses wrong assumptions | Inject latest boundaries and operation ID on every resume; review at group boundary |
| Source operation model is incomplete | Cannot capture arbitrary shell changes | Declared-scope scans first; record deviations; phase execution-scope support later |
| SQLite and JSONL diverge | Corrupt recovery | JSONL remains authoritative; SQLite projection is rebuildable |
| Strong supervisor dominates cost | Loses small-model advantage | Sparse triggers, intervention budget, compare with no-supervisor baseline |
| Architecture duplicates upstream Pi capability | Maintenance debt | Follow repository upstream investigation checklist before implementation |

# 26. Open questions

These questions require explicit decisions during implementation:

1. Should `CoordinationState` live directly on `Ferment` or be a separately folded projection referenced by Ferment ID?
2. Should a task group own whole steps only, or can a step be split into group-owned work items?
3. What is the minimum stable boundary schema: free-form facts plus evidence, JSON Schema, or language-specific symbol signature?
4. Which commands require exclusive runtime resources by default?
5. Should operation blobs live in `.kimchi`, Git objects with retention refs, or a future artifact service?
6. How should dirty user changes be represented in the initial source snapshot?
7. Can the current Agent manager safely resume one worker across several steps without expanding its context beyond useful limits?
8. Which metrics are available from current telemetry without new provider data?
9. When should a task-group repair keep the same worker versus spawn a replacement?
10. What should happen when a planner declares parallel work but static/LSP evidence predicts high coupling?

Record answers as Ferment decisions or repository ADRs before coding dependent tasks.

# 27. Definition of done

The overall feature is done when:

- Ferment can persist and replay task groups, dependencies, boundaries, assignments, handoffs, operations, conflicts, and verification records.
- The scheduler starts all and only dependency-ready groups within configured budgets.
- A persistent worker can own multiple related steps.
- Direct dependents receive validated compact handoffs.
- Source changes can be captured and applied as operations without branch/worktree identity.
- Stale source versions create explicit conflicts.
- Central verification routes repair locally.
- Feature flags restore current behavior.
- Unit, integration, property, and TUI E2E tests pass.
- Benchmarks report correctness, wall clock, tokens, waste, and partition quality.
- Internal rollout meets agreed thresholds.
- Permanent documentation is committed under `/docs/`.

# 28. Coding-agent execution protocol

For every backlog task:

```text
1. Claim the YAML task.
2. Confirm all dependencies are done.
3. Read the listed repository files and AGENTS.md.
4. Restate the task boundary in the agent report.
5. Implement only that boundary.
6. Add colocated tests.
7. Run listed validation commands.
8. Record evidence and changed files in YAML.
9. Update architecture decisions when necessary.
10. Mark done only after acceptance criteria pass.
```

Worker completion report:

```yaml
status: completed
summary: <one concise paragraph>
steps_completed:
  - <concrete outcome>
remaining_steps: []
files_touched:
  - <path>
verification:
  - <command and result>
evidence:
  - <test or artifact reference>
architecture_changes: []
```

A worker that discovers work outside its task records a follow-up task or blocker. It does not silently absorb the work and destroy the dependency graph.

# 29. Tracked backlog summary

The canonical machine-readable backlog is `kimchi-cohesion-aware-multi-agent-tasks.yaml`. The phases below summarize execution order.

| Milestone | Main outcome | Entry tasks |
|---|---|---|
| M0 Baseline | Metrics, settings, shadow planning | KMA-001 to KMA-004 |
| M1 Coordination | Groups, DAG, scheduler, persistent workers, handoffs | KMA-101 to KMA-110 |
| M2 Source operations | Snapshots, operations, CAS apply, conflicts | KMA-201 to KMA-208 |
| M3 Cohesion | Dependency extraction and grouping recommendations | KMA-301 to KMA-305 |
| M4 Execution scopes | Staging/COW abstraction and competitive mode | KMA-401 to KMA-404 |
| M5 Supervision and rollout | Sparse supervisor, adaptive regrouping, canary | KMA-501 to KMA-504 |

# 30. References

## Kimchi repository evidence

- **K1.** Kimchi repository, snapshot inspected 2026-08-16: https://github.com/getkimchi/kimchi
- **K2.** Repository agent guidelines: `AGENTS.md`
- **K3.** Ferment event store: `src/ferment/event-store.ts`
- **K4.** Ferment domain types and parallel cohorts: `src/ferment/types.ts`
- **K5.** Subagent extension and steering/resume tools: `src/extensions/agents/index.ts`
- **K6.** Agent report, outcome, task reference, and isolation types: `src/extensions/agents/personas/types.ts`
- **K7.** Ferment Agent spawn guard: `src/extensions/ferment/agent-spawn-guard.ts`
- **K8.** Ferment step start, verification, report validation, and budgets: `src/extensions/ferment/tools/steps.ts`
- **K9.** Ferment continuation scheduler: `src/extensions/ferment/scheduler.ts`
- **K10.** Ferment storage design: `docs/ferment-storage-schema.md`

## External sources

- **R1.** Anthropic, Claude Code Agent Teams: https://code.claude.com/docs/en/agent-teams
- **R2.** Anthropic, Claude Code cost management: https://code.claude.com/docs/en/costs
- **R3.** Yang et al., *When Parallelism Pays Off: Cohesion-Aware Task Partitioning for Multi-Agent Coding*, arXiv:2606.00953: https://arxiv.org/abs/2606.00953
- **R4.** Huang et al., *What Should Agents Say? Action-state Communication for Efficient Multi-Agent Systems*, arXiv:2606.05304: https://arxiv.org/abs/2606.05304 and https://github.com/iNLP-Lab/PACT
- **R5.** Asthana et al., *Runtime-Structured Task Decomposition for Agentic Coding Systems*, arXiv:2605.15425: https://arxiv.org/abs/2605.15425
- **R6.** Yu et al., *Shepherd: A Runtime Substrate Empowering Meta-Agents with a Formalized Execution Trace*, arXiv:2605.10913: https://arxiv.org/abs/2605.10913
- **R7.** Jujutsu concurrency and operation log: https://jj-vcs.github.io/jj/latest/technical/concurrency/
- **R8.** Jujutsu first-class conflicts: https://jj-vcs.github.io/jj/latest/conflicts/
- **R9.** GitButler parallel agents: https://docs.gitbutler.com/ai-agents/parallel-agents
- **R10.** Wang and Zheng, *Fork, Explore, Commit: OS Primitives for Agentic Exploration*, arXiv:2602.08199: https://arxiv.org/abs/2602.08199 and https://github.com/multikernel/branchfs
- **R11.** Zhong et al., *Don't Let AI Agents YOLO Your Files*, arXiv:2604.13536: https://arxiv.org/abs/2604.13536
- **R12.** Yang et al., *BAMAS: Structuring Budget-Aware Multi-Agent Systems*, AAAI 2026: https://ojs.aaai.org/index.php/AAAI/article/view/40226
- **R13.** Pi Messenger: https://github.com/nicobailon/pi-messenger
- **R14.** Pi Agent Teams: https://github.com/tmustier/pi-agent-teams
- **R15.** Beads: https://github.com/gastownhall/beads
- **R16.** OpenHands: https://github.com/OpenHands/OpenHands
- **R17.** MetaGPT: https://github.com/FoundationAgents/MetaGPT
- **R18.** AutoGen: https://github.com/microsoft/autogen
- **R19.** CrewAI: https://github.com/crewAIInc/crewAI
- **R20.** LangGraph: https://github.com/langchain-ai/langgraph

All external sources were checked on 2026-08-16. Recent preprints are supporting evidence, not settled consensus; their reported results must be reproduced against Kimchi workloads before product defaults change.
