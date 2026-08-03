# Workflow definitions

This directory holds the `kimchi-workflows` workflow definitions that
`WorkflowAgent` (`src/kimchi_agent/workflow_agent.py`) runs.

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
- `test/ferment-oneshot.test.ts` — that workflow's behavioural test suite
  (ported from kimchi-workflows' own `test/` when the workflow moved here;
  see "Typechecking and tests" below), scripting every agent step and
  stubbing the git/verify calls so it pins the WIRING without a model or a
  container. This directory is not `*.workflow.ts`-discoverable and never
  copied anywhere `WorkflowAgent` looks for a workflow to run — see "What
  goes here" below for why a workflow file itself must stay non-recursively
  at this top level regardless.

`tb-solver` — the other workflow designed for comparison against
`ferment-oneshot` — is **not** here. It was designed around a wall-clock
deadline the adapter no longer supplies (harbor hands `agent_timeout_sec`
only to the oracle agent), and porting its scheduling to that reality is
future work, not a mechanical move. It still lives in the
`kimchi-workflows` checkout at
`benchmarks/terminal-bench/tb-solver.workflow.ts`.

### Why `ferment-oneshot`'s input schema doesn't match `tb-solver`'s

`ferment/contract.ts` declares its own `taskInputSchema` —
`Type.Object({ instruction: Type.String() })` — rather than importing
`tb-solver`'s (which also has a `deadlineIso: Type.String()` field, required).
`ferment-oneshot` never reads a deadline anywhere in its steps; it is bounded
only by harbor's own agent-phase timeout, enforced from outside the
container, never told to the workflow (see the "Budgets" comment at the top
of `ferment-oneshot.workflow.ts`). The harbor adapter's envelope is exactly
`{"instruction": ...}` (`workflow_agent.py`'s `_pre_launch_commands`), and the
extension validates input against a workflow's declared schema **before** the
run starts — so a required `deadlineIso` this workflow never sends would fail
every run's input validation in the first second.

## What goes here

- Every workflow must be a `*.workflow.ts` file, **at the top level of this
  directory**. `discoverWorkflows` (`kimchi-workflows/src/host/workflow-catalog.ts`)
  does a non-recursive `readdir` for `*.workflow.ts`, so a workflow file
  nested in a subdirectory is invisible to every name-based lookup — only its
  helper modules may live under a subdirectory (like `ferment/` here), reached
  by relative import from the top-level file. The upload is recursive so those
  helpers reach the container; discovery is not. `WorkflowAgent.install()`
  fails at install if nothing that reaches the container can serve the
  requested `workflow=`.

  A nested file can still be run by path —
  `workflow=.kimchi/workflows/<subdir>/<file>.workflow.ts`, which
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
  `WorkflowAgent`'s `workflow=<name>` agent kwarg is passed straight through
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
directly. `WorkflowAgent.install()` uploads it verbatim to a staging path,
`/installed-agent/workflows`, once per install. Each run then copies that
staging path into the project directory the extension actually looks in —
`.kimchi/workflows/`, relative to whatever `$PWD` kimchi launches from —
immediately before `kimchi` starts. That final hop is where `resolveWorkflow`
finds workflows by name; nothing about the extension's catalog resolution is
adapter-specific.

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
nothing to clean up before a trial. `WorkflowAgent.install()` stages a copy
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
