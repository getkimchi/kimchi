# ACP wire compatibility for agent-side changes

Provenance: retro of the background-bash workstream (#1727/#1728/#1729). One failure class
recurred: **agent-side work whose side effects leak onto the ACP wire or into turn
lifecycle, visible to clients that opted into nothing**. Main-turn emissions,
before/after-turn work, replay, artifacts, permission cards, ext-methods, context
injection. Nothing malicious: Pi-side assumptions shipped without checking what the ACP
schema promises and without asking "what does a plain client see change?".

This doc is the rule of thumb for any future harness work that touches the ACP surface.
"Touches the ACP surface" is broader than it reads: feature work living entirely in
`src/extensions/` routinely has ACP side effects (wakes, message projections, idle
keys), because pi events are the same events the ACP server serializes. Not editing
`src/modes/acp/` does not mean "no wire impact".
Rules here derive from the spec, not from the incident list. Read the anchor each rule
cites before following the rule.

## The umbrella contract

**A client that opts into nothing must see nothing change.** Every ACP client we didn't
write implements a partial view of the protocol and assumes: agent runs exist only inside
`session/prompt`; the run ends when the response returns; `rawInput` is what the agent
wrote; unknown `_meta` is ignorable decoration. Break any of those and the failure
surfaces at the client, not in our logs. The class spans more than turns: payload shape,
turn timing, context content, replay, artifacts. Any agent-related work with a side
effect on any of these counts.

## Spec anchors

Every rule below cites one of these. Quote the spec, not this doc, when arguing about a
change. (Verified against the v1 pages; the spec is versioned, so re-verify the wording
when v2 stabilizes.)

- **[Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn).** A turn
  begins at `session/prompt` and ends when the Agent responds with a `StopReason`.
  Cancellation: on `session/cancel` the Client **MUST** answer pending permission
  requests with the `"cancelled"` outcome, and the Agent **MUST** respond to the original
  `session/prompt` with the `cancelled` stop reason. Explicitly: *"Session updates are
  not limited to active prompt turns."* And the spec's own capability-gating precedent:
  the Agent **MUST NOT** send `notice` updates unless the client advertised
  `clientCapabilities.session.notices: {}` at initialize; same for `compaction_update` /
  `compaction_summary_chunk` vs `session.compaction`.
- **[Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls).**
  `rawInput`: *"The raw input sent to the tool"*, meaning the tool's input, not enriched
  display data. Patch semantics: on a `tool_call_update`, omission and `null` leave the
  previously reported value unchanged. The `name` field is the schema's slot for the
  programmatic tool name: *"`title` describes this invocation for users, while `kind`
  provides a coarse presentation category"*. Names that must survive client-side mapping
  go in `name`, never piggybacked inside the `title` string.
- **[Initialization](https://agentclientprotocol.com/protocol/v1/initialization).**
  Capability advertisement at `initialize` is the spec's mechanism for new surface:
  *"Clients and Agents **MUST** treat all capabilities omitted in the `initialize`
  request as **UNSUPPORTED**."* Version negotiation: the Agent **MUST** respond with the
  requested version if it supports it, otherwise with the latest version it supports.
- **[Session setup](https://agentclientprotocol.com/protocol/v1/session-setup).**
  `session/load`: the Agent **MUST** replay the entire conversation as `session/update`
  notifications; compactions replay with *"the same update, chunk, and patch semantics
  as live delivery"*. Generalize: **replay = fresh wire history**; live and replay
  follow the same semantics.
- **[Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility).**
  `_meta` is the schema's reserved extensibility slot (`{ [key: string]: unknown }`).
  *"Implementations **MUST NOT** add any custom fields at the root of a type that's part
  of the specification."* Naming: reverse-DNS (`dev.kimchi/<name>`-style keys,
  `_`-prefixed custom methods). Unrecognized notifications are only a **SHOULD-ignore**,
  so bundling custom behavior into notifications without a capability gate is still a
  compat risk.
- **[RFDs](https://agentclientprotocol.com/rfds/about).** ACP's change process:
  Draft → Active → Preview → Completed, with a v2 subgroup. *"Experimental implementation
  may begin, properly feature-gated with the RFD name."*

## Supporting facts (learned the expensive way)

- **ACP sessions broadcast.** Multiple processes attach to one pi session, and a pi
  session also runs with no ACP head (TUI/headless/workers). Nothing on the wire is
  per-client.
- **ACP is all-or-nothing.** A client can't implement half the protocol; an old client
  must get the old protocol, complete and unchanged.
- **Replay is wire-visible.** Whatever replay attaches to historical blocks reaches the
  client on load; "just recording" is not wire-neutral.
- **Artifacts, follow-ups, idle-key work are wire-visible.** Same contract applies.
- **E2e proves serialization, not survival.** The reference client accepts any `_meta`
  and follows empty-chunk turns; real clients do neither.
- **Protocol-version drift** surfaces at real clients as "client out of date", not in CI.

## Rules

1. **Default-invisible.** *(Anchor: prompt-turn §notices/§compaction gating precedent.)*
   Before shipping anything agent-side touching the ACP wire, turn lifecycle, context, or
   replay, answer: *what does a client that opts into nothing see change?* If the answer
   is not "nothing", the change gets an explicit opt-in gate: a
   `clientCapabilities._meta` key echoed at initialize, following the process-scoped flag
   pattern in `src/extensions/bash-background/session-policy.ts`
   (`setBackgroundRunsPermitted` / `getBackgroundRunsPermitted`, mapped from the
   `backgroundRuns` client capability).
2. **Schema-first.** *(Anchor: tool-calls §rawInput + patch semantics.)* New wire content
   names its field in the spec/SDK first; if it is not in the schema, it goes in `_meta`.
   Never invent top-level fields (the spec reserves them). `rawInput` is the agent's
   verbatim input on **every** emission path (args-complete, pending, in_progress,
   permission), and computed or live state never merges into it. Tool names that clients
   must map belong in the spec'd `name` field (or registered `_meta`), never encoded
   into `title`.
3. **Scope checklist for any agent-side feature.** Walk before implementing: main-turn
   emissions? work outside turns (wakes, idle keys, completion logic)? artifacts?
   replay/time-travel? context injection (`sendMessage`/`sendCustomMessage`)? permission
   prompts? ext-methods? ext-notifications? Each "yes" is another surface where rules 1
   and 2 must hold.
4. **Facts of the past → transcript entries; live context → `_meta`.** Record with
   `sessionManager.appendCustomEntry` (pi `CustomEntry`: never model context, no trigger
   semantics). `sendCustomMessage` projects everything to a user-role message; use it to
   message, not to record. "Display-only" comments don't change that.
5. **Per-session, never per-client.** Broadcast sessions and headless sessions both
   exist: wire content must be identical for every attached client and correct with none.
6. **Replay = fresh wire history.** Replay never resolves live state on behalf of
   historical entries; it emits only what the transcript recorded. Corollaries:
   - **Identity is session-scoped, not turn-scoped.** Clearing an upstream→ACP id map at
     `agent_start` makes replay of the interrupted turn's tail re-announce already-seen
     calls under fresh ACP ids, and id-keyed clients render duplicate rows. Reuse the id
     the session already allocated, or explain in the diff why not.
   - **Persist before emit.** Any wire-visible terminal fact (outcome, settle, boundary)
     must land in the transcript BEFORE the wire emission; a crash between the two leaves
     replay contradicting what a live client saw. (`src/modes/acp/tool-calls/background.ts`
     settle persistence is the precedent.)
7. **No-dead-window rule.** *(Anchor: prompt-turn §lifecycle.)* "No turn active" is a
   state where the client believes nothing is running; any effect there (a wake that
   grows model turns, a context edit, a new ext-method request the client never declared)
   is the unsolicited-turn failure in miniature. The spec *permits* ordinary
   `session/update`s outside turns; the risk is any effect a partial-view client has no
   surface for.
8. **Protocol version is a compat surface.** *(Anchor: initialization §version
   negotiation.)* The negotiated `protocolVersion` is pinned against the SDK's
   `PROTOCOL_VERSION` in CI (`npm run check:acp-wire` / the acp structural e2e), so an
   upstream bump fails with a name on it instead of drifting to clients.
9. **Ground v1 extensions in v2 RFDs.** *(Anchor: RFDs.)* When a feature ACP v2 is known
   to be addressing gets a custom v1 surface from us (a capability, an ext method, a
   `_meta` shape), design that surface after the relevant v2 RFD: names, semantics,
   gating. Migration to v2 should then be a rename rather than a semantic wedge. Check
   the v2 RFD subgroup before designing any new extension; cite the RFD in the constant's
   comment. Where no RFD exists, note that explicitly. "Own design, no spec track" is a
   decision to make on purpose.
10. **`ctx.ui.mode === "rpc"` is not "ACP".** The harness sets `mode: "rpc"` for ACP at
    the UI-context construction site in `src/modes/acp/server.ts` (the inline comment
    admits the borrowed meaning), but Pi's own native RPC mode reports the same string.
    For ACP-strict gating use `IS_ACP_MODE` / `isAcpSessionHost()` in
    `src/modes/acp/state.ts`, never a `ctx.mode` string compare. Treat any need for that
    check as a smell: ideally Pi-side code shouldn't know whether it runs under ACP at
    all; mode branches are an escape hatch. Cite the reason in the diff when you add one.

## Not covered here (and why)

- **Client-side fixes.** Clients are outside this repo; their breakage taught the rule.
- **TS-side schema lint for ToolCall extras.** SDK types already constrain shape; the
  failures were semantic placement.
- **Real-client smoke matrix.** See the verification stance in `AGENTS.md`.

## Evidence lineage

Unsolicited-turn gating: #1728 (`session-policy.ts`). Replay id re-allocation on wake:
`toolCallIdMap.clear()` in the `agent_start` branch of `src/modes/acp/server.ts`. Title-as-name
fragility: `describeToolCall` kind-`"other"` tools had no schema slot for the tool name
(the spec's `name` field is now the fix target). Placement rework: #1727. CustomEntry vs
`sendCustomMessage`: #1729 (commit `cb2985e5c`).
