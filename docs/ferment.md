# Ferment — Cross-Session Project Management

Ferment is Kimchi's progressive-refinement project mode. It enables multi-session projects with state-driven execution, automatic progress tracking, and conversational task breakdown.

## Philosophy

> "The plan IS the state."

Every ferment persists as a JSON file in `.kimchi/ferments/`. The harness reads this file at session start, determines what to do next via a state machine, and updates the file on every action.

## Concepts

```
Ferment (epic, e.g. "Build Tetris")
├── Goal: What done looks like
├── Criteria: How we know it's done
├── Constraints: What to avoid
├── Decisions: Architectural choices
├── Memories: Gotchas & conventions
└── Phases (milestones)
    ├── Goal: What THIS phase delivers
    └── Steps (tasks)
        ├── Description: What to do
        └── Verification: Optional bash command
```

## User Commands

### Create

```
/ferment add "Build Tetris"
```

Creates ferment at `draft` status with `mode: plan`. Agent immediately guides you through scoping (goal, criteria, constraints, phases).

### List

```
/ferment
```

Shows all ferments with short IDs:
```
Ferments (ID | Name | Status | Phases):
────────────────────────────────────
  a1b2c3d4 │ Auth rewrite  │ complete │ 3
▸ 8a87e5a7 │ Build Tetris  │ running  │ 5
────────────────────────────────────
```

### Switch / Delete

```
/ferment switch 8a87e5a7    ← by ID prefix
/ferment switch "Tetris"     ← by name
/ferment delete 8a87e5a7     ← by ID prefix
/ferment delete "Tetris"     ← by name
```

Switching: loads state, triggers LLM nudge for next action.
Deleting: removes permanently.

### Mode

```
/ferment mode        ← show current mode + help
/ferment mode plan   ← conversational scoping
/ferment mode exec   ← autonomous execution (⚡)
/ferment mode auto   ← coaching mode (default)
```

| Mode | Agent behavior |
|------|----------------|
| **plan** | Conversational. Asks permission. Explains. No auto-advance. |
| **exec** | Autonomous. Acts immediately. Strips coaching. Auto-advance. |
| **auto** | Coaching. Full instructions. User decides when to act. |

### Pause / Auto

```
/pause          ← pause auto-mode
/auto           ← resume auto-mode
```

### Status

```
/status         ← full ferment dump with phases, steps, decisions
```

## Execution Flow Example

**Plan mode — scoping:**
```
User: /ferment add "Build Tetris"
Agent: What does "done" look like?
User: Single HTML file, keyboard controls, scoring
Agent: What is the definition of done?
User: Can play one full game
Agent: Suggesting phases: Canvas, Pieces, Movement, Scoring, Polish
User: Perfect
Agent: [scope_ferment] → Status: planned
```

**Exec mode — building:**
```
User: /ferment mode exec
Agent: Activate Phase 1: "Canvas & Grid" ✓
Agent: Refine Phase 1: 3 steps ✓
Agent: Step 1: Create index.html — done ✓
Agent: Step 2: Implement drawGrid() — verified ✓
Agent: Step 3: Define constants — done ✓
Agent: Phase 1 complete → Phase 2 activated
```

Every step writes state to disk. Crash → resume from last JSON.

## Status Display

```
# Ferment: Build Tetris
ID: 8a87e5a7…
Status: running

## Phases (5):
  1. [completed] Canvas & Grid
      ✓ Step 1: Create index.html
      ✓ Step 2: Implement drawGrid()
  2. ▸ [active] Piece Definitions
      ▶ Step 1: Define I piece [running]
  3. [planned] Movement & Rotation

## Decisions (2):
- D001: Use Canvas — faster than DOM

## Memories (1):
- M001 [gotcha]: innerHTML is slow
```

## Decisions & Memories

Architectural choices and gotchas that persist across sessions:
- **Decisions**: Why we chose X over Y
- **Memories**: Conventions, patterns, pitfalls encountered

## Resume & Persistence

A `ferment_reference` session entry is written on every switch/create. At session start, the harness reads this entry, loads the ferment JSON from `.kimchi/ferments/`, and injects a nudge telling the LLM exactly what to do next.

Next session:
```
$ kimchi --ferment "Build Tetris"

System: Rehydrated ferment (ID: 8a87e5a7…) [mode: exec, phase: 2/5]
Agent: Continuing Phase 2, Step 1...
```

## LLM Tools

| Tool | Description |
|------|-------------|
| `create_ferment` | Create new ferment |
| `scope_ferment` | Set goal + phases (draft→planned) |
| `activate_phase` | Start a phase (planned→active) |
| `refine_phase` | Add steps to phase |
| `start_step` | Mark step running |
| `complete_step` | Mark step done |
| `verify_step` | Run bash command + record result |
| `skip_step` | Skip a step |
| `complete_phase` | Mark phase done |
| `skip_phase` | Skip a phase |
| `complete_ferment` | Mark all complete |
| `add_decision` | Record architectural choice |
| `add_memory` | Record gotcha/convention |
| `show_ferment` | Full status dump |
| `list_ferments` | List all ferments |
| `set_ferment_mode` | Change work mode |

## State Machine

```
draft → planned → running → [paused] → complete
```

- `draft`: No goal yet. Scoping only.
- `planned`: Goal + phases defined. Ready to execute.
- `running`: Active phase executing.
- `paused`: User intervention required.
- `complete`: All phases terminal.

## Implementation

- Extension: `src/extensions/ferment.ts`
- Types: `src/ferment/types-v4.ts`
- Store: `src/ferment/store-v4.ts`
- Engine: `src/ferment/engine-v4.ts`
- Persisted: `.kimchi/ferments/<uuid>.json`
