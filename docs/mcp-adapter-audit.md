# MCP Adapter Unvendoring Audit

- **Decision date:** 2026-09-04
- **Vendored baseline:** `pi-mcp-adapter` 2.4.0 plus Kimchi changes
- **Replacement:** exact dependency `pi-mcp-adapter@2.34.0`
- **Ownership decision:** product integration stays in Kimchi; the small host project-directory patch has an upstream removal plan

## Outcome

The vendored `src/extensions/mcp-adapter/` tree has been removed. Kimchi now
uses the stable published adapter through a small facade in
[`src/extensions/mcp/`](../src/extensions/mcp/).

This is not a dependency-only swap. The facade retains the behavior that is
part of Kimchi's host contract, while adapter implementation details and fixes
that are present in 2.34.0 are deliberately returned to package ownership.
The migration removes 57 vendored files and roughly 25,000 lines of copied
implementation and tests.

The remaining facade is Kimchi's integration boundary. One temporary
dependency patch carries three host compatibilities: it separates the host's
user and project config directories (tracking issue, upstream PR plan, and
removal criteria in
[`mcp-project-config-patch.md`](mcp-project-config-patch.md)), it
restores master's #1168 tool-name sanitization and exclusion compatibility
(see the naming section below), and it retains tool annotations in the
persistent metadata cache (see the planning section below; remove once
upstream serializes annotations).

## Master rebase: naming compatibility

The rebase onto `master` at `d7211ec4` keeps the published adapter and removes
the vendored files touched by the tool-name fix in `da328918` (#1168/#1169).
The dependency patch now carries that fix into the published package, so
naming and exclusion behavior match master:

- Both name parts are sanitized at construction; structurally valid tool
  names pass through byte-for-byte (hyphens kept), anything else becomes
  `_`. `"Atlassian Rovo"` yields master's `Atlassian_Rovo` spelling instead
  of the package's hex-encoded `Atlassian_20_Rovo`, and server hyphens once
  again become underscores.
- Complete wire names are capped at the 128-char provider limit, truncating
  the server prefix first and keeping the tool tail, with a one-time warning
  per distinct original name.
- Exclusion matching follows master's fix: non-glob patterns are compared
  after normalizing hyphens and invalid characters to `_` on BOTH sides, and
  candidates include the pre-sanitization legacy spelling
  (`Atlassian Rovo_getJiraIssue`) and the sanitized form
  (`Atlassian_Rovo_getJiraIssue`) — `excludeTools` entries written against
  either era keep matching, including fully-raw dotted spellings like
  `srv.dev_a.b`.

The package's own duplicate wire-name guard (`seenNames` in
`direct-tools.ts`) retains the collision safety signal from master's fix
(the origin-tracking variant in master's `direct-tools.ts`/`index.ts` is an
equivalent, not carried over).
The tests in
[`tool-names.test.ts`](../src/extensions/mcp/tool-names.test.ts) are a
complete port of the original `da328918` regression suite (prefix modes,
byte-for-byte pass-through, nasty-input sweep, truncation and warn-once
semantics, exclusion normalization) plus namespace-proxy coverage; a failure
there means the patch stopped applying or an adapter upgrade re-introduced
the gaps. The patch header names #1168 as its tracking issue; remove the
naming portion when upstream adopts equivalent sanitization.

Namespace proxy names (`mcp__<server>`) are capped at the provider limit
natively since 2.34.0 (upstream #529, `formatServerNamespace` with a hash
fallback for long names); a 128-character server name previously produced a
133-character wire name. The 2.32.1 → 2.34.0 upgrade re-validated the facade
unit suites (101 MCP facade tests, 464 ACP tests), lint, typechecking (with
`DOM.AsyncIterable` added for the new `http-ca.ts` per-origin CA support),
and the compiled binary — `mcp keyring-check --json` passes on macOS arm64
despite 2.34.0's lazy runtime module loading (#576). OAuth credential-store
layout changes (#560: single-item records on macOS/Linux) are absorbed by
the store's own read-time compaction; Kimchi's one-shot legacy migration
tests remain green.

The binary build combines master's Photon WASM embedding with this branch's
`src/binary-entry.ts`, preserving the in-binary keyring recovery dispatcher.
ACP import discovery/application use the package's `ServerEntry` type;
session-scoped MCP setup and master's session/authentication changes are
both retained. Planning continues to exclude MCP tools by this branch's
existing policy while retaining master's Ferment V2 tools.

## Local behavior retained

### Configuration compatibility

Kimchi continues to support the project configuration path
`.kimchi/mcp.json`. The host manifest declares `piConfig.mcpProjectConfigDir`
so the adapter loads this as its normal project layer, preserving global
servers and file-backed panel management. An explicit `--mcp-config` path
takes precedence; conflicting explicit selections still use a resolved overlay.

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

On Linux, revoked session keyrings are recovered through `keyctl session -`.
Compiled builds configure the adapter's existing runtime/helper overrides to
launch the Kimchi executable with the internal `mcp-keyring-helper` command.
The binary bundles the pinned adapter's helper unchanged and installs the
native require bridge before running it. This path bypasses normal CLI startup
and needs neither system Node nor copied helper/native packages. Explicit
runtime or helper overrides are preserved; source runs retain the adapter's
installed helper. macOS and Windows do not use this Linux recovery path.

The integration uses the adapter layer: the pinned Pi SDK exposes no keyring
recovery hook, and the pi.dev catalog identifies the already-used MCP adapter.
Upstream [PR #256](https://github.com/nicobailon/pi-mcp-adapter/pull/256)
supplies the recovery protocol and overrides, so no new patch or credential
protocol implementation is needed.

Relevant code:

- [`src/extensions/mcp/oauth-migration.ts`](../src/extensions/mcp/oauth-migration.ts)
- [`src/extensions/mcp/keyring-require-bridge.ts`](../src/extensions/mcp/keyring-require-bridge.ts)
- [`src/extensions/mcp/keyring-recovery.ts`](../src/extensions/mcp/keyring-recovery.ts)
- [`src/binary-entry.ts`](../src/binary-entry.ts)
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

In plan mode Kimchi exposes only read-only-qualified MCP direct tools. A tool
qualifies when the server publishes `annotations.readOnlyHint: true`; when the
server publishes NO annotations at all, a name-prefix convention (`get_`,
`search_`, `list_`, `read_`, `fetch_`) applies as a best-effort signal with a
one-time warning per promoted tool. Any published annotations veto the
convention. The gateway (`mcp`), `mcpScript`, and namespace proxies always
stay blocked: each offers arbitrary server-side execution.

Annotations reach the facade through the adapter's persistent metadata cache,
which a third patch hunk keeps by serializing `annotations` alongside name and
schema. The facade registers a `registerReadOnlyToolProvider` with the profile
manager; planning profiles union provider names with the planning catalog. A
planning snapshot is refreshed before the agent starts, closing the race where
direct tools finish registering after the initial profile selection.

The permission hook uses the same session-scoped provider, including for tool
names such as `atlassian_getJiraIssue`. Only registered adapter tools qualify.
Disabled servers, expired caches, and metadata for a different configuration
cannot grant read-only access. Ambiguous wire names are blocked in Plan mode;
use distinct server prefixes and tool names to avoid collisions. The facade
also preserves upstream exclusions and app-only tool visibility.

The facade also checks the active planning state when any adapter-owned tool is
executed. A stale or forced call that is not read-only-qualified returns
`plan_mode_mcp_blocked` before it can reach the MCP server. Outside plan mode,
the gateway and direct tools retain their normal behavior. This restores the
vendor fork's read-only classification (`tool-metadata.ts` semantics in
[#1168](https://github.com/getkimchi/kimchi/pull/1168)) as facade behavior on
published-package data.

Relevant code:

- [`src/extensions/mcp/index.ts`](../src/extensions/mcp/index.ts)
- [`src/extensions/mcp/read-only.ts`](../src/extensions/mcp/read-only.ts)
- [`src/shared/planning/tool-session-scope.ts`](../src/shared/planning/tool-session-scope.ts)
- [`src/shared/planning/tool-catalog.ts`](../src/shared/planning/tool-catalog.ts)
- [`src/shared/planning/tool-profile-manager.ts`](../src/shared/planning/tool-profile-manager.ts)
- [`src/extensions/permissions/index.ts`](../src/extensions/permissions/index.ts)

### Conservative adapter defaults

The facade disables the model-facing `mcpScript` tool and omits the MCP
gateway entirely when no server is configured. Direct-tool updates are folded
back through Kimchi's active tool profile so the adapter cannot silently widen
a restricted profile. Adapter-specific visibility votes keep removed or
deselected direct tools out of later snapshots, including after plan mode exits.
Explicit uses of the retired `mcpSearch`,
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
| Plan-mode MCP exposure leak | A non-read-only direct or gateway MCP tool becomes visible or callable during planning | TUI scenario asserts the gateway and write-capable direct tools are neither advertised nor callable; unit tests verify read-only qualification, planning-catalog admission via the provider seam, and the defensive execution block |
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
