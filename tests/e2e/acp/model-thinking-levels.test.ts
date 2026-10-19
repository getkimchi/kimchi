// E2E for the THINKING column on the ACP surface: the list_models tool's
// tool_call_update content exposes the same table as the TUI — the tri-state
// curation from /v1/models/metadata plus the uncurated fallback (`on` =
// curated thinking without distinct levels, `not curated` = levels not
// curated, `off` = no thinking). The /model picker itself is TUI-only; ACP
// model presentation stays IDE-native.

import { afterEach, describe, expect, it } from "vitest"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

// provider "ai-enabler" lands the models in the plain "kimchi-dev" block so
// tool refs read kimchi-dev/<slug> like production.
const CATALOG = [
	{
		slug: "glm-5.3",
		displayName: "GLM 5.3",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 202_752,
		maxTokens: 8_192,
		metadata: { thinking_levels: ["low", "high", "max"] },
	},
	{
		slug: "kimi-k9",
		displayName: "Kimi K9",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262_144,
		maxTokens: 8_192,
		metadata: { thinking_levels: ["off", "low", "high", "max"] },
	},
	{
		slug: "minimax-m3",
		displayName: "MiniMax M3",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 202_752,
		maxTokens: 8_192,
		metadata: { thinking_levels: [] },
	},
	{
		slug: "kimi-k2.7",
		displayName: "Kimi K2.7",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 8_192,
	},
	{
		slug: "flash-lite",
		displayName: "Flash Lite",
		provider: "ai-enabler",
		reasoning: false,
		input: ["text"],
		contextWindow: 32_768,
		maxTokens: 4_096,
	},
]

/** Concatenate every text block of a completed tool_call_update (content + rawOutput). */
function toolResultText(update: unknown): string {
	const u = update as {
		content?: Array<{ type?: string; content?: { type?: string; text?: string } }>
		rawOutput?: { content?: Array<{ type?: string; text?: string }> }
	}
	const blocks = [
		...(u.content ?? []).map((block) => (block.content?.type === "text" ? block.content.text : "")),
		...(u.rawOutput?.content ?? []).map((block) => (block.type === "text" ? block.text : "")),
	]
	return blocks.filter(Boolean).join("\n")
}

describe("ACP integration — list_models thinking column", () => {
	let fixture: AcpFixture

	afterEach(async () => {
		await fixture?.stop()
	})

	it("exposes the thinking column and its values through tool_call_update content", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-model-thinking-levels-tool",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "glm-5.3",
			models: CATALOG,
			responses: [
				{
					toolCalls: [{ id: "call_levels", type: "function", function: { name: "list_models", arguments: "{}" } }],
				},
				{ stream: ["Listed."] },
			],
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		const result = await prompt(fixture, session.sessionId, "List the models")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("Listed.")

		const toolUpdates = fixture.client.sessionUpdates.filter(
			(u) =>
				u.sessionId === session.sessionId &&
				(u.update.sessionUpdate === "tool_call" || u.update.sessionUpdate === "tool_call_update"),
		)
		expect(toolUpdates.length, "list_models tool_call + tool_call_update").toBeGreaterThanOrEqual(2)

		const completed = toolUpdates.find(
			(u) => u.update.sessionUpdate === "tool_call_update" && (u.update as { status?: string }).status === "completed",
		)
		expect(completed, "completed list_models tool_call_update").toBeDefined()
		const output = toolResultText(completed?.update)

		expect(output).toContain("model | context | thinking | vision | reasoning | description")
		// Curated levels render canonically regardless of wire order.
		expect(output).toContain("off, low, high, max")
		expect(output).toContain("low, high, max")
		// Curated-none renders on; uncurated renders "not curated";
		// non-reasoning off.
		expect(output).toMatch(/kimchi-dev\/minimax-m3 \| \d+ \| on \| no \| yes/)
		expect(output).toMatch(/kimchi-dev\/kimi-k2\.7 \| \d+ \| not curated \| no \| yes/)
		expect(output).toMatch(/kimchi-dev\/flash-lite \| \d+ \| off \| no \| no/)
	})
})
