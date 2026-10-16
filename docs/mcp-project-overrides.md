# Project MCP overrides

Kimchi repoints pi-mono's project config directory via `piConfig.mcpProjectConfigDir = ".kimchi"` (see [mcp-project-config-patch.md](mcp-project-config-patch.md)). All project-level MCP state therefore lives under `<project>/.kimchi/` — upstream pi's `.pi/mcp.json` is never read by kimchi.

## Overriding a server for one project

Add a project-level override file at `<project>/.kimchi/mcp.json`. Configs are merged per field: fields you omit (e.g. `command`, `url`) are inherited from the server's definition elsewhere (for example the user-global `~/.config/kimchi/harness/mcp.json`).

To disable a globally defined server just for this project, use an override-only entry:

```jsonc
// <project>/.kimchi/mcp.json
{ "mcpServers": { "<serverName>": { "disabled": true } } }
```

To re-enable it later, set `"disabled": false` or delete the override entry.

## `disabled`, not `enabled`

The MCP adapter has no `enabled` field — `{ "enabled": false }` is silently ignored everywhere (upstream pi included). The correct field is `disabled: true`.

## Panel persistence

The interactive MCP panel's per-project enable/disable toggle (`ctrl+d`) persists to `<project>/.kimchi/mcp-adapter.json` (or the server's provenance file) — the same `.kimchi` directory, independent of any hand-written `mcp.json` override.
