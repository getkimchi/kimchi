# MCP project config compatibility

User-facing behavior (override files, `enabled`/`disabled`) is documented in [mcp-project-overrides.md](mcp-project-overrides.md).

Kimchi stores user MCP configuration under `<agentDir>/mcp.json` and project MCP configuration under `.kimchi/mcp.json`. Upstream pi 1.3's native MCP discovery reads `<project>/.pi/mcp.json`; kimchi does not accept `.pi` inside repositories (zero `.pi` references ship in kimchi), so a patch on `@earendil-works/pi-coding-agent` repoints the discovery literal to `.kimchi/mcp.json`:

- `dist/extensions/mcp/config.js` — discovery path in `loadMcpConfig`
- `dist/cli.js`, `dist/index.js` — user-facing strings (help text, error messages)

The trust-gating resource list (`KIMCHI_TRUST_REQUIRING_PROJECT_RESOURCES` in the same package) already names `.kimchi/mcp.json`, so project MCP servers keep requiring project trust.

The patch is covered by `src/upstream-mcp-project-config-patch.test.ts`, a text-and-syntax contract test against the installed dist. Preservation of user configuration across the format change (adapter → native) is handled by the one-shot config migration in `src/extensions/mcp/config-migration.ts`, which folds legacy layers (`~/.config/mcp/mcp.json`, `.mcp.json`, `mcp-adapter.json`) into the canonical files and stamps `mcp-native-migration.done`. Fields the native runtime cannot express (custom code-mode templates, OAuth shorthands, `requestHeadersCommand`, …) are dropped and listed in `mcp-native-migration-report.json`, with a one-time notice at startup.

Tracking: none — the `.kimchi` location is a kimchi product decision; upstream has no concept of it. Remove the patch only if upstream adds a host-overridable project-config directory.

The patch was generated with `pnpm patch` / `pnpm patch-commit`, then installed with `pnpm install --no-frozen-lockfile`; do not edit the patch file directly. Patch-commit strips header comments and may rewrite the `patchedDependencies` spec — verify both after regenerating.
