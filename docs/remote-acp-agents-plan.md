# Remote Sessions — `kimchi --remote`

## Context

Today, `kimchi` runs the agent loop locally: pi-mono draws the TUI, `AgentSession` calls
the LLM at `https://llm.cast.ai/openai/v1`, and tools execute on the user's machine.
The cloud touchpoint is just the LLM API.

We want a new mode where the **TUI stays local** (same look, same shortcuts, same
extensions) but the **entire agent loop — LLM calls, tool execution, working directory,
context — runs in a managed cloud kimchi process**. This makes sessions:

- **Portable**: a session id can be picked up from any device.
- **Resilient**: a dropped network blip reconnects to the same in-flight agent without
  losing turn state.
- **Isolated**: tools run in a clean cloud sandbox, not on the developer's box.

User-facing UX:

```bash
kimchi --remote
```

Looks identical to the local interactive mode. Under the hood, the local process
authenticates against `https://llm.kimchi.dev`, opens a WebSocket to a server-side
kimchi agent keyed by session id, and forwards every TUI action to that agent and every
agent event back to the TUI.

This is greenfield work in the repo. There is no existing "remote" code path —
the only network I/O kimchi does today is LLM calls (`src/models.ts`,
`src/auth/validator.ts`) and MCP-over-HTTP for remote MCP servers. The closest
existing pattern to draw on is the MCP HTTP transport handling in
`src/extensions/mcp-adapter/server-manager.ts`, which deals with the same
shape of problem (Bearer-auth a remote endpoint, fall back gracefully on
auth/transport errors).

## Goals (v1)

- `kimchi --remote` boots the same interactive TUI as plain `kimchi`, with the agent
  loop running in the cloud.
- Two-step session bring-up:
  1. `POST https://llm.kimchi.dev/v1/remote-sessions/{sessionId}:authenticate`
     with the user's existing CAST AI API key → short-lived `connectToken`.
  2. WebSocket to `wss://llm.kimchi.dev/v1/remote-sessions/{sessionId}:connect`
     with the connect token → bidirectional NDJSON-RPC.
- Reconnect: on WS close, re-authenticate, re-connect to the same session id, and the
  server-side agent state continues where it left off without the user retyping
  anything.
- A clean, narrow contract between local and remote so the server team can build the
  cloud side independently.

## Non-goals (v1)

- No multi-user collaboration on one session. One client per session id at a time.
- No offline replay. If the client misses events while disconnected, the server may
  replay them on reconnect (server-side concern); v1 client just renders what it's sent.
- No file sync between local cwd and remote cwd. The remote agent's working dir is
  whatever the cloud sandbox provisions.
- No session migration from local → remote (continuing a previously local session in
  the cloud). v1 starts a remote session fresh.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Local machine                                                │
│                                                               │
│   kimchi --remote                                             │
│   ┌────────────────────────┐    ┌──────────────────────────┐ │
│   │  pi-mono InteractiveMode│   │ RemoteSessionRuntime     │ │
│   │  (TUI, input, render)  │◄──►│  - HTTPS authenticate    │ │
│   └────────────────────────┘    │  - WSS connect           │ │
│                                 │  - reconnect supervisor  │ │
│                                 │  - line forwarder        │ │
│                                 └──────────────┬───────────┘ │
└────────────────────────────────────────────────│─────────────┘
                                                 │
                              POST :authenticate │   wss :connect
                              (Bearer api-key)   │   (Bearer connectToken)
                                                 ▼
┌────────────────────────────────────────────────────────────────┐
│  llm.kimchi.dev                                                │
│                                                                │
│   ┌───────────────────────┐     ┌────────────────────────────┐ │
│   │ Auth + token issuer   │     │ Session router            │ │
│   │  validates api-key    │     │  sessionId ↔ agent process │ │
│   └───────────────────────┘     └─────────────┬──────────────┘ │
│                                               │ stdio          │
│                                  ┌────────────▼─────────────┐  │
│                                  │ kimchi --mode <wire>     │  │
│                                  │  full agent loop         │  │
│                                  │  isolated cwd / tools    │  │
│                                  └──────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

Two transports, one local entry point:

- **HTTPS** for the short-lived `:authenticate` request (REST, returns JSON token).
- **WSS** for the long-lived `:connect` session, carrying NDJSON-RPC frames in both
  directions. Each WebSocket text message contains exactly one JSON-RPC line — no
  fragmentation, no batching at the transport layer.

The local process never speaks to the LLM or runs tools; it's a TUI + a transport.

## Wire protocol: pi-mono RPC over WS

There are two NDJSON-RPC dialects kimchi already speaks on stdio. The decision below
is made — kept here so the trade-off is documented.

| Property                 | ACP (`--mode acp`)                       | pi-mono RPC (`--mode rpc`)                |
| ------------------------ | ---------------------------------------- | ----------------------------------------- |
| Designed for             | IDEs (Zed, OpenClaw)                     | Programmatic clients driving a TUI        |
| Surface                  | `initialize`, `newSession`, `prompt`, `cancel`, `sessionUpdate` notifications | `prompt`, `steer`, `followUp`, `abort`, `getState`, `setModel`, `cycleModel`, `compact`, `fork`, `clone`, `getMessages`, `getCommands`, `bash`, …  (see `RpcClient` in `@earendil-works/pi-coding-agent`) |
| Streaming                | `agent_message_chunk` / `tool_call` notifications | `AgentEvent` stream (richer event types) |
| Already integrated client side? | No `ClientSideConnection` consumer in this repo | Yes — `RpcClient` is the existing client API |

The local TUI needs every method in the right column. ACP can't drive steering, model
cycling, fork, or compaction; extending it with custom methods would reinvent pi-mono's
RPC. RPC mode is also already exercised in production by `RpcClient`, so the server
side reduces to "spawn `kimchi --mode rpc` and bridge its stdio onto a WebSocket".

**Decision: use the pi-mono RPC protocol on the wire**, framed inside WebSocket text
messages — one JSON-RPC line per WS text frame. Server runs `kimchi --mode rpc`. Local
side speaks the same protocol from a WebSocket transport instead of a child-process
stdio.

## HTTP / WS contract

The server team owns these endpoints; this section is the contract the local client
will code against.

### `POST /v1/remote-sessions/{sessionId}:authenticate`

Request:
```http
POST /v1/remote-sessions/{sessionId}:authenticate HTTP/1.1
Host: llm.kimchi.dev
Authorization: Bearer <kimchi-api-key>           # the user's CAST AI key
Content-Type: application/json

{
  "client": {
    "version": "0.1.0",
    "platform": "darwin-arm64",
    "wireProtocol": "pi-rpc-v1"
  }
}
```

Response 200:
```json
{
  "connectToken": "ey…",         // opaque, server-defined
  "expiresAt": "2026-05-10T13:45:00Z",
  "wsUrl": "wss://llm.kimchi.dev/v1/remote-sessions/{sessionId}:connect"
}
```

Response 401 / 403 / 404 / 409: surfaced verbatim to the user as a startup error.

The session id is supplied **by the client** (pi-mono's locally generated session id —
the one captured today in `sessionIdCaptureExtension` at `src/cli.ts:83-92`). The local
`SessionManager.create()` mints it before any remote call so the same id is available
for both `:authenticate` and any subsequent reconnect; this preserves idempotency on
both sides.

The server stores session state keyed by **(user, sessionId)**, with the user
identified by the api-key bearer presented to `:authenticate`. Client-minted ids do
not have to be globally unique — only stable for the lifetime of the local CLI process
— because the user-scoping prevents cross-user collisions. The api-key is otherwise
not retained server-side beyond the auth check; it never travels on the WebSocket.

### `WSS /v1/remote-sessions/{sessionId}:connect`

WebSocket upgrade with `Authorization: Bearer <connectToken>`. Token is single-use or
short-TTL; if a previous client is already connected to the session id, the server's
choice is to either reject (409) or take-over (close the older socket with a specific
code). Recommended: take-over, so a crashed local CLI can reattach without manual
cleanup.

Once upgraded:

- Each WS text message = one JSON-RPC line, exactly as stdio's NDJSON would carry.
- No binary frames in v1.
- Server sends a `ping` every 30s; client responds with `pong` (Node WebSocket does
  this transparently).
- Either side can close. Close codes:
  - `1000` normal — local clean exit.
  - `4001` token expired — client triggers re-authenticate + reconnect.
  - `4002` taken over by another client — client exits with a clear message.
  - `4003` server-side session finished (user closed remote) — client exits 0.
  - other → log + reconnect attempt with backoff.

### Reconnect

When the WS closes with a recoverable code (or a network error):

1. Mark the runtime as "reconnecting" (TUI status line shows it).
2. Discard the old `connectToken`.
3. Retry `:authenticate` with the **same** session id, exponential backoff (1s, 2s, 4s,
   capped at 30s; total give-up at 5 min).
4. On 200, open a new WS to `:connect` with the new token.
5. Server replays any events emitted while the client was disconnected — the protocol
   carries enough state (`getState`, `getMessages`) for the client to resync without
   replays, so this is a server-implementation concern. Local client just calls
   `getState()` once after reconnect to refresh the TUI.
6. Resume normal operation. Pending requests issued before the disconnect are retried.

### Cwd and environment

`newSession` in pi-mono RPC carries an optional `cwd`. v1: server ignores it and
provisions its own ephemeral sandbox per session id. v2 may accept a server-defined
"workspace name" the user can reference.

## Local implementation

### CLI entry point

A new top-level flag `--remote` is recognized at the same pre-dispatch sniff point as
`--mode acp` (see comment at `src/cli.ts:97-99` — the discouragement against extending
that sniff is for *new modes*, but `--remote` is a single short-circuit, so it
qualifies).

```ts
// src/cli.ts (additions)
const remoteMode = isRemoteFlag(process.argv.slice(2))   // returns boolean
// …
if (remoteMode) {
  const { runRemoteSession } = await import("./modes/remote/index.js")
  await runRemoteSession({ extensionFactories, agentDir, config })
  return
}
```

Why a flag, not a subcommand: the user wants the same UX as plain `kimchi` — startup
banner, TUI, settings, themes, extensions. A subcommand (`kimchi remote-session`) would
short-circuit before that path. The flag preserves the standard boot flow and just
swaps the runtime host.

### `runRemoteSession`

New module `src/modes/remote/`:

- `src/modes/remote/index.ts` — orchestrator. Resolves api-key from config; mints a
  fresh session id (or reuses an existing one if `--continue`/`--session` is present);
  calls `:authenticate`; opens the WS; constructs a `RemoteRuntimeHost`; hands it to
  pi-mono's `InteractiveMode`.
- `src/modes/remote/auth.ts` — `authenticateRemoteSession(sessionId, apiKey)`. Returns
  `{ connectToken, expiresAt, wsUrl }`. Throws typed errors mapped to user-facing
  messages (401: "log in", 403: "no remote-sessions entitlement", 404: "session id
  unknown — should not happen", network: "couldn't reach llm.kimchi.dev").
- `src/modes/remote/transport-ws.ts` — WebSocket wrapping. Exposes
  `ReadableStream<Uint8Array>` / `WritableStream<Uint8Array>` over the socket and
  contains the small line-splitter / line-writer helpers (~30 LoC). One WS text
  message carries one JSON-RPC line.
- `src/modes/remote/runtime-host.ts` — implements pi-mono's `AgentSessionRuntime`
  surface (or, if pi-mono adds a `runtimeFactory` hook, a thinner adapter). Translates
  `runtime.session.prompt(...)` into RPC `prompt` calls; subscribes to RPC events and
  re-emits them as `AgentSessionEvent` for the TUI.
- `src/modes/remote/reconnect.ts` — supervisor that holds the current WS, watches for
  close, runs the backoff loop, swaps in a new WS, and notifies the runtime so the TUI
  can show reconnecting state.

The local code path stays small (~600 LoC) because most of the work is forwarding bytes
and translating events. The hard part is the runtime-host adapter; see "pi-mono
integration" below.

### Reuse from existing code

| Need                            | Reuse                                                  |
| ------------------------------- | ------------------------------------------------------ |
| Bearer-auth `fetch` patterns    | `src/auth/validator.ts:27-54`                          |
| Read `apiKey` from config       | `loadConfig()` / `readApiKeyFromConfigFile()` in `src/config.ts:225-262` |
| Remote-endpoint transport plumbing (HTTP + Bearer + error mapping) | `src/extensions/mcp-adapter/server-manager.ts:82-170` |
| RPC wire-protocol types         | `RpcCommand`, `RpcResponse`, `RpcEventListener`, `RpcSessionState` from `@earendil-works/pi-coding-agent` (top-level public exports — see `index.d.ts`) |
| RPC client class itself         | **Cannot reuse** — `RpcClient` hardcodes `child_process.spawn` with no transport seam. We write our own thin `RemoteRpcClient` (~150 LoC) that consumes the same wire types over a WebSocket. |
| NDJSON line framing             | Inline in `transport-ws.ts` (~10 LoC LF-only splitter). pi-mono's `attachJsonlLineReader`/`serializeJsonLine` are internal (`./modes/rpc/jsonl.js`) and not exposed by the package's `exports` field. |
| Env-var override for credentials | Mirror the `KIMCHI_API_KEY` handling at `src/cli.ts:134-140` |

NDJSON line splitting and per-line forwarding are simple enough to write inline in
`transport-ws.ts` (~30 LoC). No prior helper to share — historically there was a TCP
proxy in `src/modes/acp/proxy.ts` with `lineReader`/`forwardLines`, but it has been
removed from the tree. If a future feature needs the same primitives, they can be
extracted from `transport-ws.ts` into a shared util at that point.

### pi-mono integration: replicate `main()` locally

Constraint: pi-mono is treated as an immutable dependency. We do **not** modify
`@earendil-works/pi-coding-agent`. Everything the local kimchi needs to bootstrap a
remote session is composed from pi-mono's already-exported APIs plus our own code.

`InteractiveMode` (constructed with an `AgentSessionRuntime`, see
`interactive-mode.d.ts:93`) is the only TUI entry point we need. Pi-mono's `main()` is
the function that today builds that runtime from a local agent session and hands it
off. We re-implement the parts of `main()` that are still relevant for the remote case,
and swap the one step that creates the agent session.

#### What we copy from pi-mono `main()` (verbatim or near-verbatim)

Reference: `node_modules/@earendil-works/pi-coding-agent/dist/main.js`. The relevant
flow is the interactive branch (lines 320–566 of that file). We replicate, in order:

1. **Arg parsing** via pi-mono's exported `parseArgs` (from `cli/args.js`).
   `kimchi --remote ...` reuses the same flag set so `--continue`, `--session`,
   `--model`, `--thinking`, `--theme`, `--extensions`, etc. all behave identically.
   The only kimchi-specific addition is the `--remote` flag itself, sniffed in
   `src/cli.ts` like `--mode acp` is today.
2. **Migrations** (`runMigrations(cwd)`) — needed for config compat across
   pi-mono versions.
3. **Cwd, `agentDir`, `SettingsManager`** setup — same as `main()` does at
   `main.js:375-378`.
4. **`SessionManager`** — `createSessionManager(parsed, cwd, sessionDir, settings)`.
   This is where the **session id** comes from (pi-mono mints it locally, see
   `src/cli.ts:84-91` for how it's read today). For `--remote`, the same locally-minted
   session id is what we pass to the cloud `:authenticate` endpoint. The server scopes
   sessions by `(user, sessionId)` pair so client-minted ids do not need to be globally
   unique — only stable for idempotency across reconnects.
5. **`AuthStorage.create()`** for credential resolution.
6. **CLI extension/skill/prompt-template/theme path resolution** (`resolveCliPaths`).
7. **Services** — `createAgentSessionServices({ cwd, agentDir, authStorage,
   extensionFlagValues, resourceLoaderOptions: { ..., extensionFactories } })`. This
   loads kimchi's extensions, the resource loader, settings, and the model registry on
   the local side. We keep this so the local TUI's extensions (skill rendering, theming,
   permissions UI, etc.) work just like in local mode.
8. **Diagnostics collection** — same code as `main.js:431-438`.
9. **Theme init** — `initTheme(settingsManager.getTheme(), true)`.
10. **Initial message preparation** — `prepareInitialMessage(parsed, ...)` so
    `kimchi --remote -m "first prompt"` works.

#### The one step we replace

In pi-mono's `main()`, the inner `createRuntime` factory at `main.js:409-474` builds a
local agent session via `createAgentSessionFromServices(...)`. That function spins up
the LLM provider client, binds local tools, and returns `{ session, sessionStartEvent }`
where `session` is a fully-functional local `AgentSession`.

For `--remote`, we provide our own factory that returns an object of the **same shape**
but with a remote-backed session:

```ts
// src/modes/remote/runtime-factory.ts (sketch)
const createRemoteRuntime: CreateAgentSessionRuntimeFactory = async (ctx) => {
  const services = await createAgentSessionServices({ ... })   // same as main()
  const transport = await connectRemoteSession({               // ours
    sessionId: ctx.sessionManager.getSessionId(),              // pi-mono-minted id
    apiKey: resolveApiKey(),
  })
  const session = await createRemoteAgentSession({             // ours
    services, sessionManager: ctx.sessionManager, transport,
  })
  return {
    session,
    sessionStartEvent: { /* synthesized from initial RPC getState() */ },
    services,
    diagnostics: [...services.diagnostics, ...transport.diagnostics],
  }
}
```

Then we feed the factory into pi-mono's exported `createAgentSessionRuntime(...)` —
exactly as `main.js:476-480` does — and pass the resulting `runtime` straight into
`new InteractiveMode(runtime, options)` and `interactiveMode.run()`.

`createAgentSessionServices`, `createAgentSessionRuntime`, `InteractiveMode`,
`AuthStorage`, `SessionManager`, `SettingsManager`, `parseArgs`, `runMigrations`,
`initTheme`, `prepareInitialMessage` are **all** exported from the pi-mono package
already (verified in `index.d.ts`). The only thing we don't have is `createRuntime`'s
internals, which is the part we're intentionally replacing.

#### What we don't replicate

- `runRpcMode` / `runPrintMode` branches — `--remote` only supports interactive.
- Export branch (`parsed.export`) — local feature, unchanged in remote mode.
- `--list-models` — could be made remote-aware later; v1 errors out under `--remote`.
- `--no-session`, `--fork`, `--resume` — v1 blocks combinations with `--remote` that
  don't make sense (see "CLI entry point" above) and surfaces a clear error.
- Stdin piping (print mode) — irrelevant in interactive remote.

The local main replica lives in `src/modes/remote/run-interactive.ts`. It will be
~250 LoC of straight-forward composition over pi-mono's public API.

### Implementing `RemoteAgentSession`

`createAgentSessionRuntime` (and downstream `InteractiveMode`) treat `runtime.session`
as an `AgentSession` — pi-mono's exported class. The class is concrete, not an
interface, but its public surface (callable methods, `.subscribe()` events) is
documented and stable. Our `RemoteAgentSession` is a hand-rolled implementation of the
same public surface with every method routed to the remote.

Architecture:

```
┌──────────────────────────────────────────────────┐
│ RemoteAgentSession                               │
│   - implements AgentSession's public surface     │
│   - holds a RemoteRpcClient (ours)               │
│   - holds a SessionManager (pi-mono, local)      │
│   - in-memory mirror of session messages         │
│     (populated from RPC getState() + events)     │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│ RemoteRpcClient                                  │
│   - request id allocator                         │
│   - pendingRequests: Map<id, deferred>           │
│   - eventListeners: Set<(event) => void>         │
│   - send(method, params): Promise<result>        │
│   - on(event-listener)                           │
│   - line-in / line-out wired to a Transport      │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│ WebSocketTransport (ours)                        │
│   - wraps node:WebSocket                         │
│   - message → line, line → message               │
│   - close-code → semantic event for supervisor   │
└──────────────────────────────────────────────────┘
```

**What we reuse from pi-mono's RPC**: the wire protocol *types*. `RpcCommand`,
`RpcResponse`, `RpcEventListener`, and `RpcSessionState` are all exported from
`@earendil-works/pi-coding-agent`'s top-level entry point (verified in the package's
`exports` field and `index.d.ts`). They give us the full set of command discriminators,
parameter shapes, response shapes, and event shapes that `kimchi --mode rpc` already
produces and consumes. Importing those types means our `RemoteRpcClient` is
typechecked against the same protocol the server emits, with no schema duplication.

**What we cannot reuse**: the `RpcClient` *class itself*. Reading
`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js`:

- The constructor takes only `RpcClientOptions` ({ cliPath, cwd, env, provider, model,
  args }) — every option targets a child process.
- `start()` calls `spawn("node", [cliPath, ...args], ...)`, sets up
  `attachJsonlLineReader(this.process.stdout, ...)`, and writes commands to
  `this.process.stdin`.
- `stop()`, `send()`, `handleLine()` are all bound to `this.process`.
- Fields are private; there is no constructor-injected transport, no protected hook
  to override `send()`, and the methods that bind to `this.process` are not virtual.

Subclassing or monkey-patching to redirect to a WebSocket would require overriding
`start`, `stop`, `send`, and `handleLine` — i.e., almost the whole class — which is
not reuse.

**What we do, then**: write a small `RemoteRpcClient` (~150 LoC) whose **public method
surface mirrors `RpcClient`'s shape** (so the adapter layer above is symmetric) but
whose internals use a `Transport` instead of a child process. The interesting bits —
request id allocation, `pendingRequests` map, response-vs-event line discrimination,
per-request timeout — are mechanical translations of `RpcClient`'s pattern, not
original logic. The 10-line LF-only JSONL splitter is reimplemented inline since
`attachJsonlLineReader` / `serializeJsonLine` are internal modules
(`./modes/rpc/jsonl.js`) and the package's `exports` field doesn't expose them.

Mapping `AgentSession` calls to RPC:

| `AgentSession` method (called by TUI) | RPC method (sent over WS)              |
| ------------------------------------- | --------------------------------------- |
| `prompt(text, opts)`                  | `prompt`                                |
| `abort()`                             | `abort`                                 |
| `setThinkingLevel(level)`             | `setThinkingLevel`                      |
| `setModel(model)`                     | `setModel`                              |
| `cycleModel()`                        | `cycleModel`                            |
| `compact(opts)`                       | `compact`                               |
| `bash(cmd)`                           | `bash`                                  |
| `getMessages()`                       | `getMessages` (cached after first call) |
| `dispose()`                           | local close + WS close 1000             |
| `subscribe(listener)`                 | local — fed by translated RPC events    |

Each TUI-side `subscribe()` delivers `AgentSessionEvent`s. The local `RemoteAgentSession`
translates incoming RPC `AgentEvent`s (the lower-level event type pi-mono RPC mode
emits) into the higher-level `AgentSessionEvent` shape `InteractiveMode` expects. This
translation table is a small adapter — most events map 1:1 (text deltas, tool start/end,
turn end). Items the local session would normally compute (token counts, stats) come
back via `getState()` after each turn.

Trade-off: this duplicates pi-mono's `AgentSession` public surface in our codebase. If
pi-mono evolves the surface, we have to follow. We keep the adapter mechanical — no
business logic — so updates are mostly add/remove method bindings.

### State machine

```
                 ┌──────────────────────┐
                 │ idle                 │
                 │ (no connection)      │
                 └──────────┬───────────┘
                            │ runRemoteSession()
                            ▼
                 ┌──────────────────────┐
                 │ authenticating       │── HTTP error ──► fatal-startup
                 └──────────┬───────────┘
                            │ token
                            ▼
                 ┌──────────────────────┐
                 │ connecting           │── ws-error ──► reconnecting
                 └──────────┬───────────┘
                            │ ws-open
                            ▼
                 ┌──────────────────────┐
                 │ connected            │
                 │ (TUI active)         │
                 └─────┬─────────┬──────┘
                       │         │ user-quit ──► closing ──► exit
                       │ ws-close (recoverable)
                       ▼
                 ┌──────────────────────┐
                 │ reconnecting         │── max-attempts ──► fatal-network
                 │ (backoff)            │
                 └─────┬────────────────┘
                       │ token + ws-open
                       ▼
                  back to connected
```

`reconnecting` is visible in the TUI footer ("reconnecting…"); user can Ctrl-C to abort
and exit.

## Server-side contract (what the server must implement)

- Accept `POST /v1/remote-sessions/{id}:authenticate`. Validate the Bearer api-key
  against the same identity backend `src/auth/validator.ts:27-54` uses today. Return a
  short-lived (≤5 min) connect token bound to the session id and the validated
  identity.
- Accept WS upgrades on `/v1/remote-sessions/{id}:connect`. Validate the connect
  token. On first connection for a session id: spawn a `kimchi --mode rpc` child in an
  isolated cwd, with the right CAST AI credentials in env so it can hit the LLM.
  Bridge WS text frames ↔ child stdin/stdout, line by line.
- On client disconnect: keep the agent process alive for at least 60s to allow
  reconnect; after that, send SIGTERM, then SIGKILL with grace.
- On agent exit: send WS close `4003`.
- Authentication and session ownership: associate session id with the identity that
  first authenticated it. Reject `:authenticate` for that id from a different identity.

This is a separate codebase. The local plan above only requires the contract.

## File-level changes (local)

New:

- `src/modes/remote/run-interactive.ts` — entry point; replicates the relevant
  branches of pi-mono's `main()`. ~250 LoC.
- `src/modes/remote/runtime-factory.ts` — the `CreateAgentSessionRuntimeFactory` that
  swaps in remote session creation.
- `src/modes/remote/remote-agent-session.ts` — `RemoteAgentSession` class implementing
  pi-mono's `AgentSession` public surface, backed by RPC over WS.
- `src/modes/remote/rpc-client.ts` — our pi-mono-RPC client over a `Transport`.
- `src/modes/remote/transport-ws.ts` — WebSocket transport (Bearer upgrade, line
  framing, close-code mapping). ~30 LoC of NDJSON splitter inline.
- `src/modes/remote/auth.ts` — `authenticateRemoteSession(sessionId, apiKey)` HTTPS
  call. Typed errors mapped to user-facing messages.
- `src/modes/remote/reconnect.ts` — supervisor with backoff and re-auth.
- `src/modes/remote/event-translation.ts` — RPC `AgentEvent` →
  `AgentSessionEvent` adapter table.
- `src/modes/remote/types.ts` — shared types (`AuthenticateResponse`, close-code
  enums, RPC method names).
- Tests alongside each, plus an end-to-end test that runs a fake server.

Modified:

- `src/cli.ts` — add `isRemoteFlag()` sniff (parallel to `isAcpMode()` at
  `src/cli.ts:104-111`) and the dispatch branch around `src/cli.ts:292`. The branch
  imports and calls `runRemoteSession` from the new module instead of pi-mono's
  `main()`.
- `src/commands/help.ts` — document the `--remote` flag.
- `src/config.ts` — no schema change; v1 reads only the existing `apiKey`. (A future
  iteration may add `remoteEndpoint` for self-hosted users; out of scope.)

Untouched:

- `src/modes/acp/server.ts` — unchanged.
- `node_modules/@earendil-works/pi-coding-agent` — never edited. We compose its
  exported APIs only.

## Tests

Unit tests (Vitest, in `src/modes/remote/`):

- `auth.test.ts` — happy path, 401, 403, 404, network error → typed errors. Use a
  `node:http` test server.
- `transport-ws.test.ts` — round-trip lines through a real `node:http` server using the
  `ws` package as a dev dep (not a runtime dep — the server side of the test only).
  Cover stdin EOF, server-initiated close (1000, 4001, 4003), and pong handling.
- `reconnect.test.ts` — supervisor against a fake transport. Drop after the first
  connect, assert the second `:authenticate` is called, assert pending in-flight
  requests resolve once the new socket is up.
- `runtime-host.test.ts` — feed canned RPC events through a fake transport, assert the
  adapter emits the right `AgentSessionEvent` sequence and that `prompt` / `abort` /
  `getState` round-trip.

Integration:

- `tests/smoke/remote-roundtrip.test.ts` — boot a local in-process server that:
  1. Accepts `:authenticate`, returns a token.
  2. Accepts the WS, spawns a real `kimchi --mode rpc` as the remote agent.
  3. Bridges WS ↔ stdio.

  Then run the local `runRemoteSession` against it and verify that an `initialize` →
  `prompt` (with a stub model that returns canned tokens) → `agent_end` cycle is
  observed end-to-end. This is the highest-leverage test — it guards both halves of the
  protocol against drift.

## Verification

Manual:

1. Stand up a local mock server (committed at `scripts/dev-mock-remote-server.mjs`,
   ~80 LoC) that implements both endpoints.
2. `KIMCHI_REMOTE_ENDPOINT=http://localhost:8787 kimchi --remote`. (env-var override
   for the hardcoded `https://llm.kimchi.dev` is gated to dev builds only.)
3. Run a session, confirm the TUI looks identical to local mode and that prompts run
   against the mock server's stub agent.
4. Kill the server mid-prompt; confirm the TUI shows "reconnecting…", restart the
   server, confirm session continues.
5. Run `kimchi --remote` twice with the same session id from different terminals;
   confirm the second one takes over and the first sees a clear "session taken over"
   message and exits.

Automated:

- `pnpm run check`, `pnpm run test`, `pnpm run test:smoke` all green.

## Phasing

Each phase ships independently and is reviewable. No pi-mono changes required at any
phase.

**Phase 1 — protocol scaffolding & auth.** Implement `auth.ts`, `transport-ws.ts`,
`rpc-client.ts`, plus the mock server script. No TUI yet. End state: a Vitest test
runs the local code through `:authenticate` → `:connect` → send a `prompt` RPC
request and observe streaming events → clean close.

**Phase 2 — `RemoteAgentSession` and main replica.** Implement
`remote-agent-session.ts` (the `AgentSession`-shaped adapter), `event-translation.ts`,
`runtime-factory.ts`, and `run-interactive.ts` (the bootstrap mirroring pi-mono's
`main()`). End state: `kimchi --remote` against the mock server boots the real TUI,
shows the same banner as local mode, round-trips a prompt, and returns to idle.

**Phase 3 — reconnect supervisor.** Wire `reconnect.ts`, close-code handling, backoff,
and the "reconnecting…" status line. End state: kill the mock server mid-session and
the TUI recovers without the user retyping anything.

**Phase 4 — production hardening.** Real-server integration test, error-message
review, telemetry events for connect / reconnect / fatal, `AgentSession`-surface
typecheck shim (open question 3), docs in `README.md`.

The reference cloud bridge happens in parallel out-of-repo; phases 1–4 unblock its
contract test as soon as Phase 1 lands.

## Open questions

1. **Endpoint host hardcoding.** v1 hardcodes `https://llm.kimchi.dev` (matching
   `src/models.ts:4`). Do we want a `KIMCHI_REMOTE_ENDPOINT` env-var override for
   internal testing only, or a config field for self-hosted customers? Plan
   assumption: env-var override gated to dev builds, no config field.
2. **What runs in the cloud sandbox.** Is it kimchi running as itself with its own
   tools? Are there cwd limits, package access, secrets? Ops concern, but the local
   client should know enough to surface "this remote sandbox doesn't have X tool" when
   relevant. v1: assume the remote is a fully-featured kimchi; surface server errors
   verbatim.
3. **`AgentSession` surface drift.** `RemoteAgentSession` mirrors pi-mono's
   `AgentSession` public surface by hand. We need a small CI check (or a periodic
   manual audit) that catches new methods added to `AgentSession` upstream that the
   remote adapter doesn't implement, otherwise the TUI will silently lose features in
   remote mode. Cheap mitigation: a typecheck shim
   `const _: AgentSession = remoteSession` that fails compilation on missing methods.
