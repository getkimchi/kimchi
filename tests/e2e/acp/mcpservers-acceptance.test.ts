// ACP integration: client sends non-empty mcpServers on session/new.
//
// The ACP v1 spec declares mcpServers as a required field on NewSessionRequest.
// Kimchi previously rejected any non-empty array with invalidParams (-32602),
// breaking every spec-compliant ACP client (IntelliJ, Zed).
//
// This test verifies that session/new with a non-empty mcpServers array
// succeeds — the session is created and a valid sessionId is returned.
// We use a dummy stdio command ("true") that won't actually start a real
// MCP server — the test only verifies the ACP layer accepts the params,
// not that the MCP server connects (that's covered by unit tests).

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"

describe("ACP integration — mcpServers acceptance", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "mcpservers-acceptance",
			responses: [{ stream: ["ok"] }],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("accepts session/new with non-empty mcpServers and returns a sessionId", async () => {
		const res = await fixture.conn.newSession({
			cwd: fixture.workDir,
			mcpServers: [
				{
					name: "test-server",
					command: "true",
					args: [],
					env: [],
				},
			],
		})
		expect(res.sessionId).toBeTruthy()
		expect(typeof res.sessionId).toBe("string")
	})

	it("accepts session/new with empty mcpServers array (backward compat)", async () => {
		const res = await fixture.conn.newSession({
			cwd: fixture.workDir,
			mcpServers: [],
		})
		expect(res.sessionId).toBeTruthy()
	})

	it("advertises mcpCapabilities.http in initialize response", async () => {
		// The fixture already called initialize during startup. Re-initialize
		// to inspect the capabilities — ACP allows multiple initialize calls
		// on the same connection (the response is deterministic).
		const init = await fixture.conn.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		})
		expect(init.agentCapabilities?.mcpCapabilities?.http).toBe(true)
		expect(init.agentCapabilities?.mcpCapabilities?.sse).toBe(false)
	})
})
