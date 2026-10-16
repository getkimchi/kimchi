# Project MCP overrides

Kimchi repoints pi-mono's project MCP config to `.kimchi/mcp.json` via a patch on the upstream discovery path (see [mcp-project-config-patch.md](mcp-project-config-patch.md)). All project-level MCP state therefore lives under `<project>/.kimchi/` — upstream pi's `.pi/mcp.json` is never read by kimchi.

## Overriding a server for one project

Add a project-level override file at `<project>/.kimchi/mcp.json`. The project layer is merged over `<agentDir>/mcp.json` after preprocessing: a project entry wins whole-server conflicts with the user-global entry, and a project entry with `enabled: false` hides the server for this project only.

```jsonc
// <project>/.kimchi/mcp.json
{ "mcpServers": { "<serverName>": { "enabled": false } } }
```

To re-enable it later, set `"enabled": true` or delete the project entry.

## `enabled` (native) vs `disabled` (legacy)

pi 1.3's native MCP config uses `enabled: false`. Kimchi's the pre-migration adapter format used `disabled: true`; the one-shot startup migration (`mcp-native-migration.done` stamp) translates `disabled: true` → `enabled: false` in place, so both spellings work after the upgrade, but new files should use `enabled`.

## Permissions

The directory permissions guided `0600` convention ([config-migration](docs/mcp-project-config-patch.md)) applies to both files.
