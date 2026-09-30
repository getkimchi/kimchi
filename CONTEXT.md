# Kimchi Harness

The Kimchi coding harness — a terminal coding agent that extends the pi-mono SDK (`@earendil-works/pi-coding-agent`) with Kimchi-specific extensions (billing, telemetry, MCP, login, remote-run, ferments).

## Language

**Status panel**:
The read-only overlay opened by `/status` showing a snapshot of version, login identity, session identity, cwd, model, and MCP servers.
_Avoid_: "status" alone, status line, status bar

**Status line**:
The persistent footer rendered at the bottom of the TUI showing live session indicators (phase, tags, LSP diagnostics).
_Avoid_: status bar, footer status

**Billing status**:
The budget/limit state shown by `/budget` and enforced at turn time.
_Avoid_: budget status, status (ambiguous)

**Ferment status**:
The lifecycle state (draft/planned/running/paused/complete/abandoned) of a ferment objective, shown by `/ferment-v2`.
_Avoid_: objective status, status (ambiguous)
