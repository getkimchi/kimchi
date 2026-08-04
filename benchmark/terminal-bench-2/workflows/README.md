# Workflow definitions

This directory holds the `kimchi-workflows` workflow definitions that the two
workflow adapters run:

- `WorkflowAgent` (`src/kimchi_agent/workflow_agent.py`) — hosted by the kimchi
  binary built from `target_ref`. CI input `agent: kimchi-workflow`.
- `PiWorkflowAgent` (`src/kimchi_agent/pi_workflow.py`) — hosted by stock `pi`,
  with no kimchi in the picture at all, so a result attributes to the workflow
  rather than to kimchi's extension layer underneath it. CI input
  `agent: pi-workflow`.

Same extension, same sources, same `extension=`/`workflow=` kwargs. They differ
in the project directory the extension resolves names against — `.kimchi/`
under kimchi, `.pi/` under pi, derived from the running harness's own name
(`kimchi-workflows/src/host/project-dir.ts`) — and in **whether the run is told
what its deadline is**, which is what decides where a given workflow can run.
See "Which adapter can run which workflow", below.

## What's here

- `ferment-oneshot.workflow.ts` — kimchi's one-shot ferment (`kimchi
  --ferment-oneshot`), ported 1:1 as a workflow: the same planning process, the
  same P/S/F/C gate registry, the same budget tiers, the same judge standing
  in for the user, the same verification triage, with only the ferment's
  in-session continuation machinery (stop nudges, "call X now" scheduler
  messages) removed — the engine is the state machine here, so there is no
  turn left to nudge. Its declared name is `ferment-oneshot`, matching the
  filename, which is what lets `/workflow run ferment-oneshot` resolve it by
  convention (see "A workflow is selected..." below).
- `ferment/` — that workflow's helper modules: `contract.ts` (schemas, the
  gate registry, budget tiers, and this workflow's own copy of the top-level
  input schema — see below), `prompts.ts` (what each step is told, with
  provenance back to the kimchi file it came from), and `verify.ts` (runs a
  step's verify command and gathers the diff its phase grader is shown).
- `deep-solve.workflow.ts` — a terminal-bench solver designed from measured
  terminal-bench failures rather than from kimchi: `plan → (clock → execute →
  check → audit? → checkpoint)* → report`. It owes kimchi nothing, which is the
  point of running it beside `ferment-oneshot`. Every stage is budgeted from a
  wall clock, so it runs under `pi-workflow` and not under `kimchi-workflow`
  (see below). Its declared name is `deep-solve`, matching the filename.
- `test/ferment-oneshot.test.ts` — that workflow's behavioural test suite
  (ported from kimchi-workflows' own `test/` when the workflow moved here;
  see "Typechecking and tests" below), scripting every agent step and
  stubbing the git/verify calls so it pins the WIRING without a model or a
  container. This directory is not `*.workflow.ts`-discoverable and never
  copied anywhere an adapter looks for a workflow to run — see "What
  goes here" below for why a workflow file itself must stay non-recursively
  at this top level regardless.
- `test/deep-solve.test.ts` — the same, for `deep-solve`: who may stop a run,
  what a silent judge means at each of the two judges (opposite things, on
  purpose), when the second opinion is bought, and how a doom loop is detected.

## Which adapter can run which workflow

A workflow's declared input schema decides this, and the extension validates
input against it **before** the run starts — so a mismatch fails in the first
second rather than halfway through a trial.

| | `agent: kimchi-workflow` | `agent: pi-workflow` |
| --- | --- | --- |
| envelope sent | `{instruction}` | `{instruction, deadlineIso}` |
| env supplied | — | `TB_AGENT_TIMEOUT_SEC`, `TB_MODEL` |
| `ferment-oneshot` | ✅ | ✅ (ignores the extra field) |
| `deep-solve` | ❌ input validation | ✅ |

`ferment-oneshot` never reads a deadline anywhere in its steps: it is bounded
only by harbor's own agent-phase timeout, enforced from outside the container
and never told to the workflow (see the "Budgets" comment at the top of that
file). So its `taskInputSchema` in `ferment/contract.ts` is
`Type.Object({ instruction: Type.String() })` and nothing more.

`deep-solve` is the opposite: every budget in it — how long `execute` gets this
round, whether a second opinion is still affordable, whether another round fits
at all — is computed from a wall clock, so `deadlineIso` is required. Harbor
hands `agent_timeout_sec` to the oracle agent and to nobody else, which is why
this workflow's ancestor (`tb-solver`, still in the `kimchi-workflows` checkout
at `benchmarks/terminal-bench/tb-solver.workflow.ts`) could not live here at
all. `PiWorkflowAgent` is what changed that: it reconstructs harbor's own
`Trial._compute_agent_timeout_sec` from the trial's `config.json` and the task's
`task.toml`, then sends both the deadline and the budget in. `WorkflowAgent`
does not, deliberately — a workflow scheduling itself against an invented clock
is worse than one that refuses to start.

## What goes here

- Every workflow must be a `*.workflow.ts` file, **at the top level of this
  directory**. `discoverWorkflows` (`kimchi-workflows/src/host/workflow-catalog.ts`)
  does a non-recursive `readdir` for `*.workflow.ts`, so a workflow file
  nested in a subdirectory is invisible to every name-based lookup — only its
  helper modules may live under a subdirectory (like `ferment/` here), reached
  by relative import from the top-level file. The upload is recursive so those
  helpers reach the container; discovery is not. Both adapters' `install()`
  fails at install if nothing that reaches the container can serve the
  requested `workflow=` (the shared check lives in `workflow_staging.py`).

  A nested file can still be run by path — `workflow=<project
  dir>/workflows/<subdir>/<file>.workflow.ts`, where the project dir is
  `.kimchi` under kimchi and `.pi` under pi — which
  `resolveWorkflow` tries before any name lookup. That is an escape hatch, not
  the convention: it puts a container path into `AgentInfo.version` where a
  workflow name belongs.
- Each file imports `@kimchi-dev/kimchi-workflows` (and `typebox` for its
  input/output schemas) with no `node_modules` alongside it. Both bare
  imports are supplied at load time by the extension's `jiti`-based loader
  via virtual modules (`load-workflow.ts`), which hands the workflow the
  *same* `typebox` instance the engine validates against — installing a
  second copy locally would silently produce two incompatible instances. Use
  the bare specifier (`@kimchi-dev/kimchi-workflows`), never a deep path like
  `@kimchi-dev/kimchi-workflows/dist/flow/index.js` — the loader's virtual
  module map is keyed on the published names exactly, and a deep path simply
  will not resolve inside the container.
- A workflow is selected **by its own declared name**, not by filename.
  Either adapter's `workflow=<name>` agent kwarg is passed straight through
  to `/workflow run <name>`, and the extension resolves it against this
  directory once uploaded into the container. `resolveByConvention`
  (`workflow-catalog.ts`) only accepts the `<name>.workflow.ts` path when the
  file's declared `name` equals `<name>` — so a workflow's filename and its
  `name: "..."` field must be kept in sync, or the convention lookup silently
  falls through to a full catalog scan. Editing a workflow in place changes
  its behaviour without changing its identity in `result.json`
  — give an edited variant its own file *and* its own declared name (e.g.
  `ferment-oneshot-v2`) if you want the two to be distinguishable in results.

## Where this ends up in the container

Nothing in this directory is committed to talk to `kimchi-workflows`
directly. Each adapter's `install()` uploads it verbatim to a staging path,
`/installed-agent/workflows`, once per install. Each run then copies that
staging path into the project directory the extension actually looks in,
relative to whatever `$PWD` the harness launches from — `.kimchi/workflows/`
under kimchi, `.pi/workflows/` under pi — immediately before the harness
starts. That relative hop is deliberate and is the reason neither adapter
hardcodes a workdir: the copy runs in the SAME shell as the harness, so `$PWD`
is by construction the project root `resolveWorkflow` will look under.

`PiWorkflowAgent` removes its `.pi/` again once pi exits, after copying it to
`/logs/agent/pi-project-dir` for debugging: these sources are ours rather than
the task's, and the machine is graded on the state the agent leaves behind.

## Typechecking and tests (optional, dev-only)

Nothing in this directory needs `node_modules` to **run** — the container
loads every workflow through the extension's `jiti`-based loader, which
supplies `typebox` and `@kimchi-dev/kimchi-workflows` as virtual modules with
no install step at all (see "What goes here", above). `package.json` and
`tsconfig.json` here exist purely so this ~2600 lines of TypeScript gets real
static checking during development, and so each workflow can carry a real
behavioural test suite (`test/*.test.ts`, one per workflow, vitest), instead
of having neither until a container actually runs it.

```bash
cd workflows
npm ci          # lockfile is committed; `npm install` also works
npm run typecheck
npm test
```

`@kimchi-dev/kimchi-workflows` is a normal registry dependency here, pinned to
the exact published version. Nothing else is needed: `npm install` in this
directory is self-contained, with no sibling checkout and no build step in
another repo. That pin is also the point — these tests and this typecheck are
only meaningful against the same engine version a run will actually load, so
when the `EXTENSION` default in `scripts/run-workflow.sh` moves, this pin
moves with it.

Tests import only the package's published entry points
(`@kimchi-dev/kimchi-workflows`, `@kimchi-dev/kimchi-workflows/testing`) plus
the workflow file under test and its own local helper modules by relative
path — never a deep `src/` or `dist/` path — for the same reason "What goes
here" gives workflow files themselves: those paths are not exported and are
free to change shape without notice.

**None of this dev-only scaffolding reaches a task container**, so there is
nothing to clean up before a trial. Each adapter's `install()` stages a copy
filtered through `WORKFLOWS_UPLOAD_IGNORE` and uploads that instead of this
directory: `node_modules`, `test`, `package.json`, `package-lock.json`,
`tsconfig.json`, `vitest.config.ts`, `.gitignore` and `README.md` are all
excluded. It is a denylist because a workflow may legitimately need a data
file beside it. Two tests in `workflow_agent_test.py` pin the filtering — add
any new dev-only scaffolding to that tuple and to those tests.

Worth knowing anyway, since it explains the exclusions: `npm install` here
puts tens of MB of `typescript`/`vitest`/`typebox` in `node_modules/`, plus a
`node_modules/@kimchi-dev/kimchi-workflows` entry that on some setups is a
symlink pointing *outside this directory*. Uploaded, that would be dead
weight at best and a dangling symlink at worst. `*.workflow.ts` discovery is
non-recursive, so it was never at risk of mistaking any of it for a workflow
— the cost was purely upload size and broken links.
