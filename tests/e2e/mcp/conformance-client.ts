#!/usr/bin/env tsx

import { startAcpMcpFixture } from "../acp/support/acp-fixture.js"
import { newSession, prompt } from "../acp/support/scenarios.js"
import { connectMcpServer, gatewayMcpCall, modelReply } from "../tui/support/mcp-model-script.js"

const scenario = process.env.MCP_CONFORMANCE_SCENARIO
const serverUrl = process.argv[2]
const toolScenarios = new Set(["initialize", "tools_call", "tools-call", "sse-retry"])
const authScenarios = new Set(["auth/metadata-default", "auth/pre-registration"])
const supportedScenarios = new Set([...toolScenarios, ...authScenarios])
function log(message: string): void {
	process.stderr.write(`[mcp-conformance] ${message}\n`)
}

if (!scenario || !supportedScenarios.has(scenario)) {
	throw new Error(`Unsupported Kimchi MCP conformance scenario: ${scenario ?? "(missing)"}`)
}
if (!serverUrl?.startsWith("http://") && !serverUrl?.startsWith("https://")) {
	throw new Error(`MCP conformance runner did not provide a server URL: ${serverUrl ?? "(missing)"}`)
}

if (authScenarios.has(scenario)) {
	await runAuthScenario(scenario, serverUrl)
	process.exit(0)
}

const connect = connectMcpServer("conformance")
const toolCall = gatewayMcpCall(
	"__MCP_FIRST_TOOL__",
	{ a: 2, b: 3 },
	{
		serverName: "conformance",
		toolPrefix: "none",
	},
)
const fixture = await startAcpMcpFixture({
	artifactName: `mcp-conformance-${scenario.replaceAll("/", "-")}`,
	mcp: { transport: "http", externalUrl: serverUrl, serverName: "conformance" },
	responses: [connect.response, toolCall.response, modelReply("Kimchi MCP conformance scenario completed.")],
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

async function runAuthScenario(name: string, url: string): Promise<void> {
	const rawContext = process.env.MCP_CONFORMANCE_CONTEXT
	const context = rawContext ? (JSON.parse(rawContext) as Record<string, unknown>) : {}
	const clientId = typeof context.client_id === "string" ? context.client_id : undefined
	const clientSecret = typeof context.client_secret === "string" ? context.client_secret : undefined
	const fixture = await startAcpMcpFixture({
		artifactName: `mcp-conformance-${name.replaceAll("/", "-")}`,
		mcp: {
			transport: "oauth",
			externalUrl: url,
			serverName: "conformance",
			oauth: {
				...(clientId ? { clientId } : {}),
				...(clientSecret ? { clientSecret } : {}),
			},
		},
		responses: [],
	})
	log(`Kimchi ACP fixture started for ${name}`)

	try {
		const result = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
			server: fixture.mcp.serverDefinition,
			serverName: "conformance",
		})
		if (result.needsAuth !== false || result.error !== null) {
			throw new Error(`Kimchi MCP conformance authentication did not settle: ${JSON.stringify(result)}`)
		}
		log(`Kimchi completed ${name}`)
	} finally {
		await fixture.stop()
		log("fixture stopped")
	}
}
