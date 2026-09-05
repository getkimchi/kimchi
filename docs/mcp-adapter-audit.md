# MCP Adapter Unvendoring Audit

- **Decision date:** 2026-09-04
- **Vendored baseline:** `pi-mcp-adapter` 2.4.0 plus Kimchi changes
- **Replacement:** exact dependency `pi-mcp-adapter@2.32.1`
- **Ownership decision:** no changes will be upstreamed; required integration behavior is owned locally by Kimchi

## Outcome

The vendored `src/extensions/mcp-adapter/` tree has been removed. Kimchi now
uses the stable published adapter through a small facade in
[`src/extensions/mcp/`](../src/extensions/mcp/).

This is not a dependency-only swap. The facade retains the behavior that is
part of Kimchi's host contract, while adapter implementation details and fixes
that are present in 2.32.1 are deliberately returned to package ownership.
The migration removes 57 vendored files and roughly 25,000 lines of copied
implementation and tests.

No upstream issue, pull request, or upstream removal condition is planned.
The remaining local code is the permanent Kimchi integration boundary unless
Kimchi's product requirements change.

## Local behavior retained

### Configuration compatibility

Kimchi continues to support the project configuration path
`.kimchi/mcp.json`. An explicit `--mcp-config` path takes precedence. The
facade constructs the effective configuration before creating the published
adapter, so this compatibility does not require a copied config loader.

Standard project MCP sources, including `.mcp.json`, are gated by the same
persisted project-trust decisions and `--approve` / `--no-approve` overrides as
other executable project resources. Adapter installation is deferred until the
decision is known because a cold metadata-cache bootstrap can start configured
stdio servers during adapter initialization. A denied or headless-untrusted
project receives the complete user-level upstream configuration through the
adapter's programmatic API; ACP caller-supplied servers are still accepted as
trusted caller input. Trusted sessions retain normal file-backed adapter
discovery, setup, reload, and persistence behavior.

Relevant code:

- [`src/extensions/mcp/config.ts`](../src/extensions/mcp/config.ts)
- [`src/extensions/mcp/project-trust.ts`](../src/extensions/mcp/project-trust.ts)
- [`src/cli-args.ts`](../src/cli-args.ts)

### OAuth credential migration and compiled keyring support

Legacy plaintext OAuth records are copied once into the adapter's hashed
credential layout. The migration preserves the full record, including tokens,
dynamic client registration, PKCE verifier, state, and URL. Invalid records
are left untouched with a warning, existing destination records are never
overwritten, and untrusted custom OAuth directories are not selected as
automatic migration targets.

The published adapter dynamically requires `@napi-rs/keyring`. Kimchi's Bun
binary cannot resolve that native module from its compiled virtual filesystem,
so a narrow local bridge supplies the statically bundled module. A private,
file-backed implementation is available only to isolated E2E processes. The
`mcp keyring-check --json` command always exercises native credential-store
CRUD and is run by release and canary workflows on each target OS.

Relevant code:

- [`src/extensions/mcp/oauth-migration.ts`](../src/extensions/mcp/oauth-migration.ts)
- [`src/extensions/mcp/keyring-require-bridge.ts`](../src/extensions/mcp/keyring-require-bridge.ts)
- [`src/commands/mcp.ts`](../src/commands/mcp.ts)
- [`.github/workflows/release.yml`](../.github/workflows/release.yml)
- [`.github/workflows/canary.yml`](../.github/workflows/canary.yml)

### Kimchi-owned MCP branding

Successful and failed MCP OAuth callbacks continue to use Kimchi's shared
browser templates and MCP-specific wording. The package does not expose a
callback-page renderer hook, so the facade decorates only the package's exact
self-contained callback response. State validation, PKCE, token exchange,
listener ownership, and callback cleanup remain in the published adapter.
Provider-controlled error details are decoded from the package page and then
escaped again by Kimchi's shared renderer. The package's success-page
auto-close behavior is preserved.

The same narrow adapter boundary brands the MCP App host/landing pages,
adapter command UI, adapter-classified tool guidance, and the model-facing MCP
gateway. The obsolete `/pi-mcp` alias is not exposed, and gateway instructions
do not recommend the deliberately hidden `mcpScript` tool. MCP server names,
descriptions, successful content, and server-originated errors are never
rewritten; a server is allowed to use the word “Pi” as its own content.

Relevant code:

- [`src/extensions/mcp/oauth-callback-branding.ts`](../src/extensions/mcp/oauth-callback-branding.ts)
- [`src/utils/oauth-page.ts`](../src/utils/oauth-page.ts)
- [`tests/e2e/tui/mcp-browser-branding.test.ts`](../tests/e2e/tui/mcp-browser-branding.test.ts)

### ACP caller-supplied servers

ACP `session/new` and `session/load` continue to accept caller-supplied MCP
servers. Kimchi converts ACP stdio and HTTP definitions, rejects unsupported
SSE definitions, merges each session's definitions with file configuration,
and gives the caller's definition precedence on a name collision. Each ACP
session receives its own adapter instance; no caller configuration is stored
in a process-global registry.

Relevant code:

- [`src/extensions/mcp/acp-config.ts`](../src/extensions/mcp/acp-config.ts)
- [`src/modes/acp/server.ts`](../src/modes/acp/server.ts)

### Transient CLI and Desktop probes

`kimchi mcp probe --json` and ACP `_kimchi.dev/probe_mcp_server` remain
supported. The local probe hosts a short-lived published adapter instance and
uses its public gateway contract to connect and describe tools. It applies
timeouts, supports stdio and HTTP/OAuth flows, isolates same-name/different-URL
credentials, and always shuts the adapter down.

Relevant code:

- [`src/extensions/mcp/probe.ts`](../src/extensions/mcp/probe.ts)
- [`src/commands/mcp.ts`](../src/commands/mcp.ts)
- [`src/modes/acp/ext-methods/mcp.ts`](../src/modes/acp/ext-methods/mcp.ts)

### Planning-mode safety and tool-profile integration

Kimchi must not expose write-capable MCP tools while a session is in plan
mode. The published adapter's narrowed cache metadata does not expose MCP
`annotations`, so the facade observes the raw public MCP client's `tools/list`
response and stores only the classification needed by Kimchi.

The rules are intentionally fail-closed:

- `readOnlyHint: true` is read-only.
- `readOnlyHint: false` is not read-only.
- contradictory observations are a conflict and are not read-only.
- a missing annotation may use the existing `get`, `search`, `list`, `read`,
  or `fetch` name heuristic, but only after a real tool observation.
- an unknown tool is not read-only.

Cached classifications are bound to the effective server configuration hash,
so changing a command, URL, headers, environment, auth, or tool filters makes
the old annotation cache ineligible. The classification applies both to direct
tools and gateway calls. A write or unknown gateway call attempted in plan mode returns
`plan_mode_write_blocked` before it reaches the MCP server. Session-scoped
state keeps concurrent extension/API wrappers from leaking profiles or
classifications between sessions. A planning snapshot is refreshed before the
agent starts, closing the race where direct tools finish registering after the
initial profile selection.

Relevant code:

- [`src/extensions/mcp/annotation-catalog.ts`](../src/extensions/mcp/annotation-catalog.ts)
- [`src/extensions/mcp/read-only-tools.ts`](../src/extensions/mcp/read-only-tools.ts)
- [`src/extensions/mcp/index.ts`](../src/extensions/mcp/index.ts)
- [`src/shared/planning/tool-session-scope.ts`](../src/shared/planning/tool-session-scope.ts)
- [`src/shared/planning/read-only-tool-registry.ts`](../src/shared/planning/read-only-tool-registry.ts)
- [`src/shared/planning/tool-profile-manager.ts`](../src/shared/planning/tool-profile-manager.ts)
- [`src/extensions/permissions/index.ts`](../src/extensions/permissions/index.ts)

### Conservative adapter defaults

The facade disables the model-facing `mcpScript` tool and omits the MCP
gateway entirely when no server is configured. Direct-tool updates are folded
back through Kimchi's active tool profile so the adapter cannot silently widen
a restricted profile. Explicit uses of the retired `mcpSearch`,
`mcpSearchLimit`, and `maxToolResultChars` Kimchi settings receive a migration
warning. Telemetry reports the adapter's actual weighted search provider rather
than the ignored legacy setting.

## Vendored patches deliberately dropped

The following changes existed in the 2.4.0 vendor fork but are not recreated
locally. They belong to the adapter implementation, and the stable package now
has equivalent or superseding behavior:

- Lazy and host-aware agent-directory and cache path resolution.
- Oversized-output protection after selecting compatible limits.
- Compact MCP tool call and result rendering.
- Direct-tool synchronization and first-request availability.
- Cancellation propagation to in-flight MCP calls.
- Recovery after a keep-alive MCP process crashes or its client closes.
- OAuth callback listener cleanup, port selection, strict-port behavior, and
  abort handling.
- Invalid-config warnings and empty-status handling.
- Panel display, reconnect, authentication, narrow-layout, and sanitization
  fixes.
- Host-name substitution in dynamic client registration.
- Stale cache cleanup and hot direct-tool refresh.

Keeping parallel copies of these fixes would require Kimchi to depend on
private adapter internals, recreate fixed lifecycle code, and continuously
reconcile two implementations. Any regression in these areas is now handled
by pinning or upgrading the dependency, or by a narrow Kimchi-side adapter
workaround if the regression violates a Kimchi product contract. It will not
be handled by restoring the vendor tree.

## Intentional behavior changes

These are accepted migration changes and should not be mistaken for
regressions:

- MCP search uses the package's weighted gateway search, not Kimchi's former
  BM25 implementation or combined MCP/native tool index.
- Search and describe results remain gateway results; they are not injected as
  temporary native tools for the next turn.
- Missing path-like tool arguments are no longer filled automatically with the
  session working directory.
- Output truncation and artifact handling use the package's current policy
  (50 KiB or 2,000 lines with overflow written to a temporary artifact), not
  the old Kimchi `maxToolResultChars` setting.
- Resource operations use the package's `read_<resource>` spelling rather than
  the former `get_<resource>` spelling.
- Saving the package MCP panel closes it and refreshes direct tools.
- Dynamic OAuth client registrations use the host package name `kimchi` rather
  than the old `Pi Coding Agent` name.

## Highest-risk failure scenarios and required tests

| Risk | Expected failure if broken | Coverage / release gate |
| --- | --- | --- |
| Compiled native keyring loading | OAuth cannot read or persist credentials in a distributed binary | Build the binary and run `kimchi mcp keyring-check --json` on macOS, Linux under a Secret Service session, and Windows in release/canary CI |
| OAuth layout migration | Existing users are prompted to authenticate again, lose dynamic registration, or have credentials overwritten | Compiled-process upgrade test plus invalid-record and destination-conflict unit cases |
| OAuth callback branding | Users finish authorization on an unbranded package page or provider errors render unsafe HTML | Compiled-browser success/denial scenarios plus renderer and real HTTP-response unit tests |
| Repository project trust | Opening a clone executes a project `.mcp.json` command during cache bootstrap | Compiled TUI accept/deny sentinel scenarios plus headless ACP denial and trust-resolution units |
| Product/model branding | Setup, MCP App pages, or model guidance identifies Kimchi as Pi or recommends a hidden tool | Compiled setup/browser/model-contract scenarios plus exact-boundary units |
| Plan-mode race or classification leak | A write-capable direct or gateway MCP tool becomes callable during planning | TUI scenario with explicit `readOnlyHint: true` and `false`; assert the blocked call never reaches the fixture server; unit tests for unknown/conflicting annotations and multiple sessions |
| ACP session isolation | One Desktop session sees another session's servers, or caller definitions lose precedence | ACP `session/new`/`session/load`, collision, direct-tool registration, and multi-session configuration tests |
| Probe cleanup and OAuth isolation | Probe hangs, leaves a callback listener/process alive, or overwrites another server's credentials | CLI and compiled ACP probes for stdio, HTTP, timeout/failure, OAuth, and same-name/different-URL behavior |
| Adapter startup and direct-tool synchronization | First request lacks tools, a restrictive profile is widened, or stale tools survive reconnect | TUI lifecycle, restart, stdio, failure, and planning scenarios |
| Transport/OAuth lifecycle | Cancellation is ignored, keep-alive restart fails, or HTTP authentication loops | MCP TUI HTTP/OAuth/restart suites plus MCP conformance initialize, tools, SSE retry, discovery, and pre-registration suites |
| UI replacement | Panel crashes on narrow output, fails to reconnect/save, or renders unsafe content | TUI panel/UI scenarios and focused facade tests |
| Config compatibility | `.kimchi/mcp.json`, `--mcp-config`, trust-filtered user config, or caller-wins precedence silently changes | Config precedence, trust denial, and ACP conversion/merge tests |

## Verification record

The migration is accepted only when all of the following remain green:

- Full Vitest unit/integration suite.
- `pnpm run lint` and `pnpm run typecheck`.
- All MCP TUI suites: stdio, failures, HTTP, OAuth browser branding, OAuth,
  restart, panel, lifecycle, and UI.
- ACP caller-server and probe workflows.
- MCP conformance: initialize, tool calls, SSE retry, OAuth metadata
  discovery, and OAuth pre-registration.
- `pnpm run build:binary` followed by native `mcp keyring-check`.
- Release/canary keyring checks on every distributed operating system.

Local verification on macOS arm64 has passed the full unit suite (9,515 tests;
10 skipped), all 35 MCP TUI scenarios, all eight ACP MCP scenarios, the
complete MCP conformance matrix, lint, type checking, binary compilation, and
native macOS Keychain CRUD.
The release and canary workflows contain Linux Secret Service and Windows
Credential Manager runtime checks. Those two native backends remain an
environment validation gate until a CI run executes the updated workflows;
cross-compilation alone is not evidence that they work.

Current Linux x64 verification passes all 44 focused MCP TUI scenarios,
including project-trust denial/acceptance and four compiled browser/setup/model
branding contracts, all five focused ACP MCP scenarios, and the complete
conformance matrix. The full unit run has 9,541 passing and 11 skipped tests;
its sole failure is an unrelated ferment
auto-compaction expectation reproduced on the baseline.

The broader smoke suite has three known failures outside this migration: one
live model request receives HTTP 401, and two agent-session tracking cases do
not create their expected child session files. They are not MCP release
signals.

The complete 170-scenario TUI run has 168 passing, one intentionally skipped
debugger scenario, and one environment-dependent failure: a multi-model test
expects one selected model, while the developer machine's four installed
Ollama models make the correctly rendered count five. Neither that test nor its
implementation area is changed by this migration. The complete ACP suite passes
27/27. Native Secret Service CRUD passes from the compiled Linux x64 binary in
a fresh D-Bus session using the release-workflow recipe.

## Ongoing maintenance boundary

Kimchi owns only the facade contracts listed above, including the browser-facing
callback page. The published package owns transport behavior, process lifecycle,
the callback server and its security/lifecycle logic, output protection, cache
mechanics, tool rendering, and panel implementation. Future adapter upgrades
must rerun this document's risk matrix. A package regression may be worked
around locally when necessary, but copying the package implementation back into
`src/extensions/` is explicitly out of scope.
