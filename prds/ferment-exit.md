## Problem Statement

Users can enter Ferment mode and make a ferment active, but there is no explicit way to leave Ferment mode without deleting, abandoning, completing, or merely pausing the ferment while keeping the session attached to it. This creates UI and runtime ambiguity: the footer can keep showing the ferment tile, Ferment tool visibility can remain active, permissions can remain Ferment-biased, pending plan reviews or continuation nudges can still fire, and the current agent turn can keep operating with stale Ferment prompt/tool state.

Users need a clear `/ferment exit` command that exits Ferment mode for the current session while preserving the ferment for explicit later selection.

## Solution

Add `/ferment exit` as a user-facing command that detaches the current session from the active ferment. Exit is not a lifecycle success/failure command. It must not delete, abandon, or complete the ferment.

If the active ferment is `running` or `planned`, exit first persists it as `paused` through the normal state-machine path. If it is `draft`, exit preserves the draft without mutating its persisted lifecycle status. If it is already `paused`, exit leaves it paused. After that, exit clears active Ferment session state, hides Ferment UI, restores idle Ferment tool visibility for future runs, clears transient host state, emits an audit breadcrumb, and aborts the current turn.

After exit, the user must explicitly pick the ferment again with `/ferment list` or `/ferment switch <id-or-name>`. The command must not introduce a "last exited ferment" pointer or make `/ferment resume` magically know what to resume.

## User Stories

1. As a user, I want to run `/ferment exit`, so that I can return to normal Kimchi mode without abandoning my ferment.
2. As a user, I want the Ferment footer tile to disappear after exit, so that the UI reflects that I am no longer in Ferment mode.
3. As a user, I want my active ferment preserved after exit, so that I can resume it later if I explicitly choose it.
4. As a user, I want a running ferment paused before exit, so that no persisted ferment remains misleadingly active without an owning session.
5. As a user, I want a planned ferment paused before exit, so that exit behaves consistently with session shutdown and clearly stops autonomous continuation.
6. As a user, I want draft ferments preserved on exit, so that exiting scoping mode does not destroy my initial request.
7. As a user, I want pending Ferment prompts, plan reviews, and nudges cancelled after exit, so that Ferment does not reappear unexpectedly.
8. As a user, I want Ferment lifecycle tools hidden after exit, so that the next turn is no longer a Ferment planner turn.
9. As a user, I want `/ferment exit` to work even while work is in progress, so that I can interrupt Ferment mode whenever I choose.
10. As a user, I want a clear acknowledgement after exit, so that I know which ferment was exited and whether it was paused first.
11. As a user, I want an audit breadcrumb in the transcript, so that later readers understand why Ferment stopped.
12. As a user, I want `/ferment exit` with no active ferment to be harmless, so that accidental use does not mutate state.
13. As a user, I want continuation policy left unchanged, so that exit does not silently rewrite my Ferment settings.
14. As a user, I want `/ferment exit` to be discoverable in completions and docs, so that I can find it alongside pause, resume, list, and switch.

## Implementation Decisions

- Add `/ferment exit` as the user-facing command name.
- Treat exit as session detachment, not deletion, abandonment, completion, or continuation-policy change.
- If there is no active ferment, show a no-op message such as `No active ferment to exit.` and make no state changes.
- If the active ferment is `running` or `planned`, apply the existing pause transition before clearing active state.
- If the active ferment is `draft`, preserve the persisted draft and clear only session-local/transient Ferment state.
- If the active ferment is already `paused`, leave it paused and detach from it.
- If a terminal ferment is somehow active, detach from it without trying to mutate its lifecycle.
- Clear the active ferment through the helper that also reapplies the idle Ferment tool profile.
- Clear pending plan review state for the exited ferment.
- Clear pending scoping/proposal state for the exited ferment.
- Clear scoping gate state for the exited ferment or ensure it can no longer drive the current session.
- Reset reactive continuation nudge state for the exited ferment.
- Request a footer rerender so the Ferment tile disappears immediately.
- Emit a visible audit breadcrumb or acknowledgement, for example: `Exited Ferment mode: "Auth rewrite" was paused and detached. Resume later from /ferment list.`
- Abort the current agent turn after state cleanup. PI snapshots tool visibility and prompt blocks per run, so clearing active state only affects future runs; abort is required to prevent the current stale Ferment turn from continuing.
- Do not preserve a "last exited ferment" pointer. Resuming after exit requires explicit user selection via `/ferment list` or `/ferment switch <id-or-name>`.
- Do not mutate continuation policy. Manual or automated policy remains whatever it was before exit and applies only if the user explicitly selects a ferment again.
- Use one semantic path across normal, one-shot, and interrupted execution contexts. If invoked during one-shot or while tools/workers are in progress, exit still pauses if needed, detaches, suppresses future continuation, emits the audit breadcrumb, and aborts the current run.
- Expose `/ferment exit` in parser, command completions, usage/help text, README, and Ferment docs.

## Testing Decisions

- Add command parser coverage for `/ferment exit`.
- Add command completion coverage so `exit` appears with the other Ferment subcommands.
- Add command controller tests for:
  - no active ferment
  - active draft ferment
  - active planned ferment
  - active running ferment
  - active paused ferment
  - active terminal ferment if the harness can construct that state
- Tests should assert external behavior rather than private implementation details:
  - active ferment is cleared
  - running/planned ferments are persisted as paused
  - draft ferment is preserved as draft
  - paused ferment stays paused
  - pending review/scoping state is cleared
  - idle Ferment tool profile is applied
  - footer render is requested or observable footer state no longer includes Ferment
  - current command context is aborted when a ferment was active
  - continuation policy is unchanged
  - no "last exited ferment" state is introduced
- Add or extend Ferment command tests near the existing command parser/controller tests.
- Add focused tests around PI constraints where practical: exit should abort because current run tool visibility and prompt injection cannot be unsnapshotted mid-run.

## Out of Scope

- Deleting ferments.
- Abandoning ferments.
- Completing ferments.
- Changing continuation policy.
- Adding `/ferment resume` memory for the last exited ferment.
- Introducing a new active-ferment ID pointer or any other duplicate active state.
- Guaranteeing that already-started external work is forcibly killed. Exit must make persisted state conservative and abort the current turn, but already-running tools or child processes may only stop if the PI/tool layer supports cancellation.
- Refactoring the broader `setActive()` process-environment side effect.

## Further Notes

The most important ordering requirement is: pause persisted running/planned state before clearing active runtime state. Clearing active first would bypass the existing session-shutdown safety path and could leave a ferment persisted as `running` without any owning session.

The intended user mental model is simple: `/ferment pause` keeps the session attached to a paused ferment; `/ferment exit` leaves Ferment mode. After exit, the ferment is just another saved ferment in the list.
