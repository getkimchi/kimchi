#!/usr/bin/env tsx

import { startAcpMcpFixture } from "../acp/support/acp-fixture.js"
import { newSession, prompt } from "../acp/support/scenarios.js"
import { modelReply } from "../tui/support/mcp-model-script.js"

const scenario = process.env.MCP_CONFORMANCE_SCENARIO
const serverUrl = process.argv[2]
// Native engine scope: streamable-HTTP initialize + tools_call. The auth/* and
// sse-retry scenarios belonged to the adapter's headless OAuth/SSE surfaces.
const toolScenarios = new Set(["initialize", "tools_call", "tools-call"])
const supportedScenarios = new Set(toolScenarios)
function log(message: string): void {
	process.stderr.write(`[mcp-conformance] ${message}\n`)
}

if (!scenario || !supportedScenarios.has(scenario)) {
	throw new Error(`Unsupported Kimchi MCP conformance scenario: ${scenario ?? "(missing)"}`)
}
if (!serverUrl?.startsWith("http://") && !serverUrl?.startsWith("https://")) {
	throw new Error(`MCP conformance runner did not provide a server URL: ${serverUrl ?? "(missing)"}`)
}

// Native: no connect step — the fake model's name placeholder is resolved
// from the request body's tool list (__MCP_FIRST_TOOL__ substitution), which
// carries the full native `mcp__<server>__<tool>` id.
const toolCall = {
	response: {
		toolCalls: [{ function: { name: "__MCP_FIRST_TOOL__", arguments: '{"a":2,"b":3}' } }],
	},
}
const fixture = await startAcpMcpFixture({
	artifactName: `mcp-conformance-${scenario.replaceAll("/", "-")}`,
	mcp: { transport: "http", externalUrl: serverUrl, serverName: "conformance" },
	responses: [toolCall.response, modelReply("Kimchi MCP conformance scenario completed.")],
})
log(`Kimchi ACP fixture started for ${scenario}`)

try {
	const sessionId = await newSession(fixture, fixture.workDir)
	log(`ACP session ready: ${sessionId}`)
	const result = await prompt(fixture, sessionId, `Run MCP conformance scenario ${scenario}`)
	log(`ACP prompt stopped with ${result.stopReason}`)
	if (result.stopReason !== "end_turn") {
		throw new Error(`Kimchi ACP conformance turn stopped with ${result.stopReason}`)
	}
	if (!result.chunks.includes("Kimchi MCP conformance scenario completed.")) {
		throw new Error(`Kimchi ACP conformance turn did not complete: ${result.chunks}`)
	}
} finally {
	await fixture.stop()
	log("fixture stopped")
}

// The ACP SDK connection retains reader state after the child process closes.
// All owned resources are stopped above, so terminate the short-lived conformance driver explicitly.
process.exit(0)
