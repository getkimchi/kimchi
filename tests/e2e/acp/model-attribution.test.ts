// E2E for per-message model attribution (docs/acp-model-attribution.md): the
// first chunk emitted for a messageId carries `_meta["kimchi.dev"]` naming
// the served and requested models as provider refs, later chunks of the same
// id carry none, and a reloaded session replays the same `_meta` from the
// persisted message tuple.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

// The fake backend catalog: `auto` is an ordinary entry; routing happens
// server-side and the concrete pick comes back in the response `model` field
// (`responseModel`).
const MODELS: Array<{
	slug: string
	displayName: string
	input: Array<"text" | "image">
	contextWindow: number
	maxTokens: number
}> = [
	{
		slug: "routed",
		displayName: "Fake Routed",
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
	{
		slug: "auto",
		displayName: "Auto",
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
]

// ACP warnings ride agent_message_chunk too; attribution is about the model's
// response, so drop them before asserting on chunk shape.
function isAcpWarning(update: unknown): boolean {
	const u = update as { content?: { type?: string; text?: string } }
	return u.content?.type === "text" && (u.content.text?.startsWith("[ACP]") ?? false)
}

// Helpers for writing a hand-crafted session JSONL. Kimchi's session files
// live under ~/.config/kimchi/harness/sessions/<cwd-encoded>/.
function encodeCwdDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

function writeSessionFile(homeDir: string, sessionId: string, cwd: string, entries: unknown[]): void {
	const sessionDir = join(homeDir, ".config", "kimchi", "harness", "sessions", encodeCwdDir(cwd))
	mkdirSync(sessionDir, { recursive: true })
	const fileName = `2026-10-14T00-00-00.000Z_${sessionId}.jsonl`
	const lines = entries.map((e) => JSON.stringify(e)).join("\n")
	writeFileSync(join(sessionDir, fileName), `${lines}\n`)
}

describe("ACP integration — per-message model attribution", () => {
	let fixture: AcpFixture

	afterEach(async () => {
		await fixture?.stop()
	})

	it("labels the first chunk of a routed response, and only the first", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-model-attribution-live",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "auto",
			models: MODELS,
			// Two stream items → two agent_message_chunks sharing one
			// messageId: the first carries _meta, the second must not.
			responses: [{ stream: ["Hello", " attribution"], responseModel: "routed" }],
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		const result = await prompt(fixture, session.sessionId, "Say hi")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("Hello attribution")

		const chunks = fixture.client.sessionUpdates.filter(
			(u) =>
				u.sessionId === session.sessionId &&
				u.update.sessionUpdate === "agent_message_chunk" &&
				!isAcpWarning(u.update),
		)
		expect(chunks).toHaveLength(2)
		// The fixture's fake metadata declares an "openai" sub-provider under the
		// "kimchi-dev" gateway key, and pi composes the message provider as
		// "kimchi-dev/openai" — so the refs carry that composed prefix here.
		// Production refs are the plain single-segment provider (e.g.
		// "kimchi-dev/glm-5.3").
		const metas = chunks.map((u) => u.update._meta)
		expect(metas).toEqual([
			{
				"kimchi.dev": {
					modelId: "kimchi-dev/openai/routed",
					requestedModelId: "kimchi-dev/openai/auto",
				},
			},
			undefined,
		])
	})

	it("replays the persisted tuple on session load", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-model-attribution-replay",
			responses: [],
		})

		const sessionId = "model-attribution-replay"
		const cwd = fixture.workDir
		writeSessionFile(fixture.homeDir, sessionId, cwd, [
			{
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-10-14T00:00:00Z",
				cwd,
			},
			{
				type: "model_change",
				id: "mc1",
				parentId: null,
				timestamp: "2026-10-14T00:00:00Z",
				provider: "kimchi-dev",
				modelId: "auto",
			},
			{
				type: "message",
				id: "u1",
				parentId: "mc1",
				timestamp: "2026-10-14T00:00:01Z",
				message: { role: "user", content: "hi" },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-10-14T00:00:02Z",
				message: {
					role: "assistant",
					provider: "kimchi-dev",
					model: "auto",
					responseModel: "glm-5.3",
					content: [{ type: "text", text: "reply" }],
				},
			},
		])

		await fixture.conn.loadSession({ sessionId, cwd, mcpServers: [] })

		const replayed = fixture.client.sessionUpdates.filter(
			(u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk" && !isAcpWarning(u.update),
		)
		expect(replayed).toHaveLength(1)
		expect(replayed[0].update._meta).toEqual({
			"kimchi.dev": {
				modelId: "kimchi-dev/glm-5.3",
				requestedModelId: "kimchi-dev/auto",
			},
		})
	})
})
