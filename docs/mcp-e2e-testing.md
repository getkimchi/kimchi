# MCP end-to-end testing

Kimchi's MCP end-to-end suite runs the real compiled Kimchi client against a deterministic, repository-owned MCP server. It covers both product entry points: PTY-driven TUI sessions and ACP sessions over NDJSON stdio.
## Architecture

The suite has four cooperating parts:

1. `tests/e2e/mcp/fixture-server.mjs` is a scenario-driven MCP server built on the pinned official TypeScript SDK. It supports stdio, Streamable HTTP, legacy SSE fallback, static bearer authentication, and a local OAuth authorization server.
2. `tests/e2e/tui/support/mcp-fixture.ts` creates isolated MCP configuration, event logs, loopback listeners, and an OAuth browser driver for each test.
3. The existing TUI and ACP fixtures launch `dist/bin/kimchi` with an isolated `HOME`, work directory, model configuration, MCP cache, and OAuth credential store.
4. `tests/e2e/tui/support/mcp-model-script.ts` builds deterministic gateway or direct MCP tool calls and exposes semantic accessors for the results sent back to the model. This tests Kimchi's transport and tool behavior without depending on model tool-selection quality.

Important workflows assert more than the final response:

- the terminal text or ACP events seen by the client;
- the tool definition and result sent to the next fake-model request;
- protocol events recorded by the MCP fixture;
- persisted cache or OAuth behavior across a real Kimchi process restart.

The fixture's stdout is reserved for MCP protocol messages. Diagnostics go to a per-test JSONL event file. OAuth access tokens, refresh tokens, authorization codes, and client secrets are not written to that event log.

## Running the tests

Build and run every MCP end-to-end tier:

```sh
pnpm run test:e2e:mcp
```

Run one tier while iterating after `pnpm run build:binary`:

```sh
pnpm run test:e2e:mcp:tui
pnpm run test:e2e:mcp:acp
pnpm run test:e2e:mcp:conformance
```

Run one TUI file by its name fragment:

```sh
node scripts/run-tui-e2e.js mcp-oauth
```

The dedicated `MCP E2E` GitHub Actions workflow runs the aggregate suite for pull requests, or on manual dispatch.

## Coverage

| Area | End-to-end behavior |
| --- | --- |
| stdio | initialization, discovery, gateway calls, search-to-direct-tool injection, resources, error results, mixed content, and empty gateway status |
| direct tools and cache | first-session exposure specification and successful direct invocation after a real process restart |
| failures | invalid arguments, startup failure, disconnect during a call, bounded slow calls, transport loss, malformed HTTP, and cancellation specification |
| Streamable HTTP | initialization, session IDs, custom headers, static bearer authentication, unavailable server behavior, and legacy SSE fallback |
| OAuth | protected-resource and authorization-server metadata, dynamic client registration, authorization code with PKCE, browser callback, denial, token failure, persistence, and refresh after restart |
| ACP | server probing, cache population, MCP-backed agent turns, image forwarding, authentication-required probing, OAuth login, and protected tool calls |
| official conformance | the pinned runner's `initialize` and `tools_call` client scenarios against Kimchi's real ACP-hosted client stack |

The suite contains two `test.fail` behavioral specifications for known product regressions:

- a configured direct MCP tool is not available to the first model request because asynchronous bootstrap completes too late;
- cancelling an agent turn does not currently propagate the abort signal as MCP `notifications/cancelled`.

Keep these tests enabled. When either starts passing, Vitest reports an unexpected pass; remove `test.fail` as part of the corresponding production fix.

## Adding a fixture behavior

Prefer extending the existing fixture over creating another server:

1. Add one deterministic tool or named scenario to `fixture-server.mjs`.
2. Record a small event at the protocol boundary that the test needs to observe. Do not include credentials or whole request headers.
3. Add an option to `McpFixtureOptions` only if the test must alter server setup. Tool inputs should normally select per-call behavior instead.
4. Add one user-recognizable workflow to the relevant `mcp-*.test.ts` file. Drive it through the real TUI or ACP boundary and assert the model and protocol boundaries where applicable.
5. Give every wait a fixed timeout and ensure fixture-owned children and listeners are stopped in teardown.

Use `test.fail` only for a stable, known product bug with a comment naming the regression. Use the TUI skip list only for genuine test instability.

## Writing a workflow with little boilerplate

Use `runMcpKimchiSession` so the callback receives a fixture whose `mcp` property is required, and use the model-script builders instead of hand-writing OpenAI tool-call envelopes:

```ts
const echo = gatewayMcpCall("echo", { message: "hello" })

await runMcpKimchiSession(
	terminal,
	{
		artifactName: "mcp-echo",
		mcp: {},
		responses: [echo.response, modelReply("The MCP server answered.")],
	},
	async (fixture) => {
		terminal.submit("Ask the MCP server to echo hello")
		await waitForText(terminal, "The MCP server answered.")
		await fixture.mcp.waitForEvent("tool_called", {
			where: { name: "echo", arguments: { message: "hello" } },
		})
		expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: hello")
	},
)
```

This verifies three production boundaries: the user-visible response, the actual MCP protocol call, and the tool result returned to the model. Prefer typed `where` filters and checkpoints over custom polling or sleeps. For process-lifecycle scenarios, use `runRestartableMcpKimchiSession`; its `restart()` waits for a verified shell exit before launching the next Kimchi process.

An empty `mcp: {}` deliberately exercises production defaults. Set `lifecycle`, `idleTimeout`, `toolPrefix`, or authentication only when that setting is the behavior under test. Add `additionalStdioServers` when a workflow needs to prove routing or isolation between multiple configured servers.

## Choosing the right test tier

Use a focused co-located unit or integration test for parsing, configuration normalization, or a protocol branch that does not need a user workflow. Use the fixture-backed TUI or ACP suite when the risk crosses process, transport, model, cache, OAuth, or content-forwarding boundaries.

A real external MCP smoke test can be useful for optional manual or scheduled compatibility checking, but it should not gate pull requests. External availability, credentials, and server changes make it unsuitable as the primary regression suite; the local fixture remains the source of deterministic CI evidence.
