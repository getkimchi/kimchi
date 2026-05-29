# IDE Adapter Extension

Generic adapter that discovers IDE plugins via lockfiles and exposes their tools to Kimchi over the Model Context Protocol (MCP).

> **Documentation**
> - [`CONTRACT.md`](CONTRACT.md) — External contract for IDE plugin authors (lockfile, auth, notifications).
> - [`ARCHITECTURE.md`](ARCHITECTURE.md) — Internal harness behaviour for contributors (constants, error handling, lifecycle).

## How it works

1. **Discovery**: Scans `$XDG_CONFIG_HOME/kimchi/ide/` for `*.lock` files written by IDE plugins.
2. **Connection**: Opens a WebSocket to each discovered IDE, authenticating with the token in the lockfile.
3. **Tool proxying**: Registers every tool exposed by the IDE under the `ide_` prefix (e.g. `ide_openFile`).
4. **Notifications**: Receives `at_mentioned` and `selection_changed` notifications from the IDE.

## Files

- `CONTRACT.md` — External API contract for IDE plugin authors
- `ARCHITECTURE.md` — Internal architecture and behaviour docs
- `types.ts` — Protocol types
- `lockfile.ts` — Lockfile scanning and parsing
- `mcp-client.ts` — WebSocket MCP client with auth token query-param support
- `at-mentions.ts` — At-mention queue and prompt injection
- `index.ts` — Extension factory
