// ACP boundary: export is not reachable through kimchi's ACP protocol
// surface. The ACP command palette is `bug` + skill commands — there is no
// export command — and `session/prompt` text (including a literal "/export")
// is queued as model input, not dispatched as a slash command (command
// dispatch lives only in the interactive editor layer). This test pins that
// claim end-to-end: with the server process cwd deliberately distinct from
// the session workDir, a "/export" prompt completes as a normal turn and no
// export file appears in either directory. If export ever becomes
// ACP-reachable, this test fails and forces the session-cwd destination
// question (see the fix-session-export plan).

import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"

/** Any file that would indicate an export side effect. */
function exportSideEffects(dir: string): string[] {
	try {
		return readdirSync(dir).filter((f) => f.endsWith(".html") || f.endsWith(".jsonl"))
	} catch {
		return []
	}
}

describe("ACP export boundary (process cwd ≠ session cwd)", () => {
	let fixture: AcpFixture
	let processCwd: string

	beforeEach(async () => {
		processCwd = mkdtempSync(join(tmpdir(), "kimchi-acp-processcwd-"))
		fixture = await startAcpFixture({
			artifactName: "export-boundary",
			// Distinct process cwd: if an export ever fired relative to either
			// directory, one of the assertions below would see the file.
			processCwd,
			responses: [{ stream: ["There is no export command on this surface."] }],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
		try {
			rmSync(processCwd, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	it("prompt text '/export' is model input, not a command: the turn completes and no export file appears in either directory", async () => {
		const ns = await fixture.conn.newSession({
			cwd: fixture.workDir,
			mcpServers: [],
		})

		const promptPromise = fixture.conn.prompt({
			sessionId: ns.sessionId,
			prompt: [{ type: "text", text: "/export" }],
		})
		const result = await Promise.race([
			promptPromise,
			new Promise<{ stopReason: "TIMEOUT" }>((resolvePromise) =>
				setTimeout(() => resolvePromise({ stopReason: "TIMEOUT" }), PROMPT_TIMEOUT_MS),
			),
		])
		expect(result.stopReason).toBe("end_turn")

		// The turn completed as a normal model round-trip.
		const chatRequests = fixture.fake.requests.filter((r) => r.url.includes("chat/completions"))
		expect(chatRequests.length).toBeGreaterThan(0)

		// No export side effects anywhere.
		expect(exportSideEffects(fixture.workDir)).toEqual([])
		expect(exportSideEffects(processCwd)).toEqual([])
	})
})
