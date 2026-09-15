import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Reasoning-capable model so /thinking exposes more than "off".
const REASONING_MODELS = [
	{
		slug: "reasoner",
		displayName: "Fake Reasoner",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"] as const,
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
]

test("/thinking changes the in-session thinking level without persisting it", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-level-session-switch",
			providerId: "kimchi-dev",
			initialModel: "reasoner",
			models: REASONING_MODELS,
			responses: [{ stream: ["Level applied."] }],
		},
		async (fixture, trace) => {
			// Session starts at the global default (medium).
			trace.step("startup")
			terminal.write("/thinking")
			await waitForText(terminal, "/thinking", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			// Upstream 0.85.1: plain Enter applies in-session only; "Ctrl+S to set as
			// default" remains advertised here because Enter does NOT persist for thinking.
			await waitForText(terminal, "Thinking Level", { timeoutMs: INPUT_TIMEOUT_MS })
			expect(viewText(terminal)).toContain("to set as default")

			// Available order: off, minimal, low, medium, high, xhigh, max (current=medium).
			terminal.write("high")
			await waitForText(terminal, "Deep reasoning", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "Thinking level: high", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("session level switched to high")
			terminal.keyEscape()

			// Level actually reaches the wire on the next turn.
			terminal.submit("say hi")
			await waitForText(terminal, "Level applied.", { timeoutMs: INPUT_TIMEOUT_MS })
			const chatRequests = fixture.fake.requests.filter((r) => r.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequests).toHaveLength(1)
			expect((chatRequests[0] as { body?: { reasoning_effort?: string } }).body?.reasoning_effort).toBe("high")
			trace.step("reasoning_effort=high on the wire")

			// And the global default stays untouched (session-only).
			const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8"))
			expect(settings.defaultThinkingLevel).toBeUndefined()
			expect(settings.modelThinkingLevels).toBeUndefined()
			trace.step("settings.json untouched")
		},
	)
})

test("/settings 'Default thinking level per model' persists a per-model override", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-level-per-model-default",
			providerId: "kimchi-dev",
			initialModel: "reasoner",
			models: REASONING_MODELS,
			responses: [],
		},
		async (fixture, trace) => {
			trace.step("startup")
			terminal.write("/settings")
			await waitForText(terminal, "/settings", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "Auto-compact", { timeoutMs: INPUT_TIMEOUT_MS })

			// Filter to the per-model thinking row via the searchable settings list? The
			// settings list is not searchable; walk down to it instead.
			for (let index = 0; index < 40; index += 1) {
				const cursorLine = viewText(terminal)
					.split("\n")
					.find((line) => line.includes("→"))
				if (cursorLine?.includes("Default thinking level per model")) break
				terminal.keyDown()
				await new Promise((resolve) => setTimeout(resolve, 50))
				if (index === 39) throw new Error("Could not navigate to 'Default thinking level per model'")
			}
			terminal.submit("")
			// Step 1/2: pick the model (only one model, preselected to current).
			await waitForText(terminal, "Per-Model Thinking Level", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			// Step 2/2: pick a level for it. (Note: level descriptions are visible
			// unfiltered, so an immediate typed filter would race the focus; walk
			// the deterministic off→minimal→low→medium→high order with arrows.)
			await waitForText(terminal, "Thinking Level for", { timeoutMs: INPUT_TIMEOUT_MS })
			for (let i = 0; i < 4; i += 1) terminal.keyDown()
			terminal.submit("")
			trace.step("override set for reasoner")

			// loop:true returns to step 1; Esc twice leaves the submenu and then /settings.
			await waitForText(terminal, "Per-Model Thinking Level", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.keyEscape()
			await waitForText(terminal, "1 configured", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS, full: false })

			const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8"))
			expect(settings.modelThinkingLevels).toEqual({ "kimchi-dev/reasoner": "high" })
			trace.step("override persisted to settings.json")
		},
	)
})
