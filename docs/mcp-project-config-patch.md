# MCP project config compatibility

Kimchi stores user configuration under `.config/kimchi/harness` and project MCP configuration under `.kimchi`. The pinned adapter uses `piConfig.configDir` for both locations. Passing the legacy project file as a global override drops user configuration; supplying the merged configuration programmatically disables the adapter's management panels.

The small `pi-mcp-adapter@2.34.0` patch adds optional `piConfig.mcpProjectConfigDir`, falling back to the original directory when absent. Kimchi sets it to `.kimchi`. Upstream then handles loading, precedence, provenance, panel persistence, and server enable/disable using its normal file-backed project layer. Source and public compiled exports carry the same change. No user configuration files are migrated or copied.

Tracking: [upstream host-path integration issue #491](https://github.com/nicobailon/pi-mcp-adapter/issues/491). Upstream PR plan: propose the optional project-directory host setting with default-path, split user/project path, config precedence, and writer/provenance tests. This local change has not been submitted upstream.

Remove the patch when a pinned upstream release supports an independent host project-config directory (adjust the manifest setting if the upstream API differs). Keep Kimchi's real-loader and terminal panel tests as compatibility checks.

The patch was generated with `pnpm patch` / `pnpm patch-commit`, then installed with `pnpm install --no-frozen-lockfile`; do not edit the patch file directly.
