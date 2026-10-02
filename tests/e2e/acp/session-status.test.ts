// ACP integration — `_kimchi.dev/session_status` ext method.
//
// Studio drives the harness over ACP and renders the session status snapshot
// as a native surface (ADR docs/adr/0001-session-status-acp-ext-method.md).
// These tests prove the structured round-trip over the wire: capability
// advertisement at initialize, the snapshot for a live session, and the
// set_session_title-style invalidParams errors.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

const SESSION_STATUS_METHOD = "_kimchi.dev/session_status"

describe("ACP integration — session_status ext method", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "session-status",
			responses: [{ stream: ["ok"] }],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("advertises session_status in the initialize capabilities _meta", () => {
		const meta = fixture.initializeResponse.agentCapabilities?._meta as Record<string, unknown> | undefined
		expect((meta?.["kimchi.dev"] as Record<string, unknown> | undefined)?.session_status).toBe(true)
	})

	it("returns a structured snapshot for a live session", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		const snapshot = await fixture.conn.extMethod(SESSION_STATUS_METHOD, { sessionId })

		// The fixture seeds config.json with an API key, so the login method is
		// the machine-readable enum, not a display string.
		expect(snapshot).toMatchObject({
			login: { method: "kimchi_account" },
			session: {
				id: sessionId,
				// Reported verbatim as the client sent it — not canonicalized.
				cwd: fixture.workDir,
			},
			model: {
				id: "basic",
				isAuto: false,
			},
		})
		expect(typeof snapshot.version).toBe("string")
		// The fake backend has no identity endpoint, and the session has no MCP
		// servers. (MCP_STATUS_EVENT does fire in ACP mode — the snapshot saw an
		// empty server list.)
		expect(snapshot.email).toBeUndefined()
		expect(snapshot.mcp).toEqual({ connected: 0, disabled: 0, failed: 0 })
	})

	it("rejects a missing sessionId with invalidParams", async () => {
		await expect(fixture.conn.extMethod(SESSION_STATUS_METHOD, {})).rejects.toThrow(/sessionId is required/)
	})

	it("rejects an unknown sessionId with invalidParams", async () => {
		await expect(fixture.conn.extMethod(SESSION_STATUS_METHOD, { sessionId: "no-such-session" })).rejects.toThrow(
			/unknown sessionId no-such-session/,
		)
	})

	it("stays callable even before any session exists (sessionless callers get invalidParams, not a crash)", async () => {
		await expect(fixture.conn.extMethod(SESSION_STATUS_METHOD, { sessionId: "x" })).rejects.toThrow(
			/unknown sessionId x/,
		)
	})
})
