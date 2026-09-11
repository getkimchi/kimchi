# ACP External Agents (Experimental)

Connect any ACP-speaking agent (Gemini CLI, any custom ACP harness, or a remote ACP endpoint) to Kimchi's subagent plane. An external agent spawned through this feature is a first-class subagent node: it appears in the TUI subagent tree, streams output like any subagent, returns its result through the normal Agent tool flow, and — when spawned with communication enabled — participates in the host-mediated coordination board and agent messaging.

**Status: experimental.** The whole feature is gated behind `--enable-experimental-features`. With the flag off there are no `acp:` agent types, no `/acp` command, and no runtime wiring.

## Quick start

1. Ensure an ACP agent is installed locally, e.g. Gemini CLI (`gemini --acp`; run `gemini` once to authenticate).

2. Configure the server (project config, checked into the repo, overrides the global config per server name):

   ```jsonc
   // .kimchi/acp-agents.json
   {
     "agent_servers": {
       "gemini": {
         "command": "gemini",
         "args": ["--acp"]
       }
     }
   }
   ```

   The global config lives at `~/.config/kimchi/harness/acp-agents.json` (same convention as the agents settings).

3. Start kimchi with the experimental flag:

   ```bash
   kimchi --enable-experimental-features
   ```

4. Ask the agent to connect it: *"Connect gemini through ACP and have it analyze the flaky test."* — the main agent spawns it like any subagent (`subagent_type: "acp:gemini"`). Use `/acp` to list configured servers.

## Config reference

```jsonc
{
  "agent_servers": {
    "<name>": {
      "transport": "stdio",          // "stdio" (default) | "ws"
      "command": "gemini",           // stdio only — executable to spawn
      "args": ["--acp"],             // stdio only
      "env": {},                     // stdio only — extra environment variables
      "cwd": "/optional",            // stdio only — working directory override
      "url": "wss://host",           // ws only — WebSocket base URL
      "sessionName": "optional",     // ws only — defaults to a derived name
      "token": "...",                // ws only — connect token
      "displayName": "Gemini",       // display name in the TUI tree
      "default_model": "gemini-2.5-pro", // applied via the experimental session/set_model after initialize (best-effort)
      "permissions": "deny"          // "deny" (default) | "allow" — stdio only
    }
  }
}
```

Invalid entries are skipped at startup with a stderr warning — never fatal.

### WS transport

`transport: "ws"` reuses the sandbox worker's ACP client: credentials are synthesized from `url`/`token`, the connection goes to `${url}/session/${sessionName}/connect`, and permission requests are always denied (the WS client has no allow path). WS is best-effort for generic endpoints; stdio is the tested path.

## How it works

```
Agent tool (subagent_type "acp:<name>", communication: "group")
  → AgentManager.spawn  (record.acp = { server: "<name>" })
    → ACP runner: spawn the agent (stdio) or connect (ws)
       initialize → newSession(cwd, mcpServers=[comms shim]) → prompt loop
  → Comms: MCP shim process ⇄ Unix socket ⇄ host IPC ⇄ AgentManager broker/board
```

- **ACP below the subagent abstraction**: the external agent is an `AgentRecord` in the one subagent manager — unified TUI tree, abort (Ctrl+X / `max_duration`), background queue, completion notifications, budgets-by-convention (`max_turns` maps to ACP turns).
- **Turns**: one ACP `session/prompt` call is one turn. Steers (`steer_subagent`) and pending peer messages are delivered as follow-up prompts between turns — steers first, then broker messages. Undelivered work is never silently dropped: it stays queued and is terminalized (with parent notification) when the record goes terminal.
- **Board + messaging**: when spawned with `communication` enabled, the host passes one MCP server in `newSession` — the kimchi comms shim. The external agent loads it and gets the same four tools in-process agents have (`list_agent_contacts`, `send_agent_message`, `post_agent_note`, `read_agent_board`), with schemas derived live from the in-process tool schemas. Tool calls proxy over a token-scoped Unix socket to the host, which re-validates the token → live record on every request and stamps author identity host-side.
- **One `acp:` spawn per session**: the external agent process lives and dies with its subagent record. There is no session persistence, `loadSession`, or forking.

## Security posture

- **Permissions default deny.** When the external agent requests a permission (e.g. to run a command), the host denies it unless the server config says `"permissions": "allow"` — an explicit opt-in for trusted local agents. Deny reasons are surfaced in the agent's tool results so you know to flip the config.
- **Board entries and messages are data, never instructions.** Posts from external agents follow the same governance as in-process agents: entries cannot grant permissions or change tasks. Messages from other agents are never the user or the host.
- **Host-stamped identity.** The external model can never assert author identity, group membership, or timestamps — the host derives all of it from the live record bound to the connection's token.
- **Liveness + revocation.** Comms dispatch requires a record in `running` or `queued` state; the manager revokes the IPC token synchronously when the record transitions to a terminal state, so a terminal external agent cannot post during the race window.
- **Never post secrets** to the board or in messages — board content is host-observable; treat it as public to the session.

## Limitations (v1)

- Transcript files for ACP agents contain the initial entry and the final result only — there is no in-process session to subscribe to.
- `RunResult.steered` is always false for ACP records; steer-equivalents are delivered as follow-up prompts and the record completes normally.
- **Parent replies to live external agents are delivered as follow-up turns.** When an external agent sends a user-question via `send_agent_message`, the ACP runner stays alive after its main turn loop — it polls for open question threads (up to 120s, 1s interval) before exiting. The parent's `reply_to_agent_message` is queued as a pending message (the session-less running path) and picked up by the runner as a follow-up ACP prompt. The question thread closes when the reply is delivered. If the runner exits before the parent replies (turn budget exhausted, abort, or the 120s wait elapses), the record goes terminal and the reply is rejected with `thread_closed` — questions from finished agents remain fire-and-forget notifications.
- No circuit breaker / health polling / auto-restart for agent servers — the process dies with the record.
- No OAuth flows for remote endpoints; WS auth is a static token.
- Tool-call content from the external agent surfaces as activity titles only.
- A hard host kill can orphan the external agent process and its comms shim (graceful paths escalate SIGTERM→SIGKILL and the shim exits when the host socket dies).

## Related

- Plan: `.kimchi/plans/acp-subagent-plane.md`
- Implementation: `src/extensions/acp-agents/`
- Tests: `src/extensions/acp-agents/*.test.ts`, `tests/e2e/tui/acp-subagent.test.ts`
