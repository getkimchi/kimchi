/**
 * E2E ACP test: corrective recovery for a rejected completion budget.
 *
 * Mirrors the TUI recovery workflow (`tests/e2e/tui/budget-cap-recovery`):
 * an oversized budget rejection is corrected once (lowered to the stated
 * ceiling) and the corrected retry completes the turn without a terminal
 * error; a second, different cap rejection after the corrected attempt
 * surfaces the terminal error to the client instead of retrying forever.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

// Metadata the serving destination does not honor: the request goes out with
// max_completion_tokens 512000 and the backend caps at 262144.
const INFLATED_MODEL = {
	slug: "kimi-k3",
	displayName: "Kimi K3",
	provider: "ai-enabler",
	input: ["text" as const],
	contextWindow: 1_048_576,
	maxTokens: 512_000,
}

const REJECTION_BODY = (cap: number, requested: number) => ({
	error: {
		message: `max_completion_tokens is too large: ${requested}.This model supports at most ${cap} completion tokens.`,
		type: "invalid_request_error",
		code: 400,
	},
})

function chatBodies(fixture: AcpFixture): Record<string, unknown>[] {
	return fixture.fake.requests
		.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		.map((request) => request.body as Record<string, unknown>)
}

describe("ACP budget cap recovery", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	it.each([
		{ enabled: false, maxRetries: 3 },
		{ enabled: true, maxRetries: 0 },
	])("surfaces the session project's terminal rejection with retry settings $enabled/$maxRetries", async (retry) => {
		fixture = await startAcpFixture({
			artifactName: `acp-budget-project-retries-${retry.enabled}-${retry.maxRetries}`,
			providerId: "kimchi-dev",
			models: [INFLATED_MODEL],
			responses: [{ status: 400, body: REJECTION_BODY(262_144, 512_000) }],
		})
		// The server process keeps its default retries. Only this trusted
		// session's cwd overrides them, reproducing process/session divergence.
		const cwd = join(fixture.workDir, "session-project")
		const projectSettingsDir = join(cwd, ".config", "kimchi", "harness")
		mkdirSync(projectSettingsDir, { recursive: true })
		writeFileSync(join(projectSettingsDir, "settings.json"), JSON.stringify({ retry }))
		await fixture.conn.extMethod("_kimchi.dev/set_path_trust", { path: cwd, decision: "trust" })
		const sessionId = await newSession(fixture, cwd)
		await expect(fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "Do the thing" }] })).rejects.toThrow(
			/The request could not be completed/,
		)
		expect(chatBodies(fixture)).toHaveLength(1)
	})

	it("corrects a rejected budget once and completes the turn without a terminal error", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-budget-cap-recovery",
			providerId: "kimchi-dev",
			models: [INFLATED_MODEL],
			responses: [
				{ status: 400, body: REJECTION_BODY(262_144, 512_000) },
				{ stream: ["Recovered with the corrected budget."] },
			],
		})

		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Do the thing")

		// The turn completes normally — the corrected rejection never surfaces
		// as a terminal error to the client.
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("Recovered with the corrected budget.")
		expect(result.chunks).not.toContain("max_completion_tokens is too large")

		const bodies = chatBodies(fixture)
		expect(bodies.length).toBe(2)
		expect(bodies[0]?.max_completion_tokens).toBe(512_000)
		// The corrective retry carried the stated ceiling — never a raise.
		expect(bodies[1]?.max_completion_tokens).toBe(262_144)
	})

	it("surfaces a terminal error when the corrected attempt is rejected again", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-budget-cap-second-rejection",
			providerId: "kimchi-dev",
			models: [INFLATED_MODEL],
			responses: [
				{ status: 400, body: REJECTION_BODY(262_144, 512_000) },
				{ status: 400, body: REJECTION_BODY(131_072, 262_144) },
			],
		})

		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Do the thing")

		// The turn ends in an error — surfaced as the JSON-RPC error path, not
		// silently, and exactly one corrective attempt was made.
		expect(result.stopReason).toBe("ERROR")

		const bodies = chatBodies(fixture)
		expect(bodies.length).toBe(2)
		expect(bodies[0]?.max_completion_tokens).toBe(512_000)
		expect(bodies[1]?.max_completion_tokens).toBe(262_144)
	})
})
