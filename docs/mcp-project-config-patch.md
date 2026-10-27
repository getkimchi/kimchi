# MCP project config compatibility

User-facing override behavior (override files, `disabled`, panel persistence) is documented in [mcp-project-overrides.md](mcp-project-overrides.md).

Kimchi stores user configuration under `.config/kimchi/harness` and project MCP configuration under `.kimchi`. The pinned adapter uses `piConfig.configDir` for both locations; project files passed as a global override therefore collide with user configuration, and a programmatically supplied merged configuration bypasses the adapter's management panels. Those collision/panel behaviors date from the 2.34.0 integration and were last re-verified there.

The `pi-mcp-adapter@5.3.1` patch (`patches/pi-mcp-adapter@5.3.1.patch`) keeps the optional `piConfig.mcpProjectConfigDir` host setting, falling back to the original directory when absent. Kimchi sets it to `.kimchi`, covering both the adapter config path (`mcp-adapter.json`) and the legacy pi-mcp compat read (`mcp.json`). Upstream then handles loading, precedence, provenance, panel persistence, and server enable/disable using its normal file-backed project layer. No user configuration files are migrated or copied.

The same patch file carries unrelated integration hunks beyond the config-directory surface — MCP tool-name sanitization and selector matching, MCP UI standard disable, OAuth loopback capture, OAuth metadata `Accept` header, and DCR `clientInfo` version. Each hunk documents its own tracking issue and removal criteria in the patch header; only the config-directory hunk is Kimchi's #491 change.

Tracking: [upstream host-path integration issue #491](https://github.com/nicobailon/pi-mcp-adapter/issues/491). Upstream PR plan: propose the optional project-directory host setting with default-path, split user/project path, config precedence, and writer/provenance tests. This local change has not been submitted upstream.

Remove the config-directory hunk when a pinned upstream release supports an independent host project-config directory (adjust the manifest setting if the upstream API differs). Keep Kimchi's real-loader and terminal panel tests as compatibility checks. Removing the other hunks is tracked separately in the patch header.

The patch was generated with `pnpm patch` / `pnpm patch-commit`, then installed with `pnpm install --no-frozen-lockfile`; do not edit the patch file directly.
