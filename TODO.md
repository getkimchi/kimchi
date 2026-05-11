# On-Demand Curator Implementation

**Branch:** feature/on-demand-curator
**Model:** minimax m2.7 for all tasks
**Location:** /Users/ibar/castai/src/kimchi-dev/.worktrees/on-demand-curator

## Tasks

- [x] Task 1: Types and Interfaces
- [x] Task 2: apply_auto_transitions (No Mutations)
- [ ] Task 3: inventory_agent_skills
- [ ] Task 4: Log Summarization
- [ ] Task 5: Review Agent Prompt Builder
- [ ] Task 6: execute_report (Two-Phase Execution)
- [ ] Task 7: Wire Everything Together in curator.ts
- [ ] Task 8: Create Extension Entry Point
- [ ] Task 9: Update /improve Skill
- [ ] Task 10: Integration Test

## Plan

See: /Users/ibar/sandbox/hermes/plans/2026-05-07-curator-implementation-plan.md

## Dependencies

Before Task 6, ensure these exist in usage.ts and skill-manager.ts:
- `setStateBatch(stateChanges: { name: string, state: string }[]): Promise<void>`
- `skillExists(name: string): Promise<boolean>`

## Current Status

Task 2: DONE (both reviewers passed)
Awaiting Task 3 dispatch