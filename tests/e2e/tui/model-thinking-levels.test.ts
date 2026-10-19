import { expect, test } from "@microsoft/tui-test"
import {
	fullText,
	INPUT_TIMEOUT_MS,
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	viewText,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * TUI E2E for the THINKING column: both model-facing surfaces — the /model
 * picker table and the list_models tool — render the tri-state curation from
 * /v1/models/metadata (`thinking_levels`): populated levels as a canonical
 * comma+space list, the explicit empty array as `on` (curated: thinking
 * exists, no distinct levels, provider default), an absent field as `not
 * curated` for reasoning models (uncurated — levels must not be inferred) and
 * `off` for non-reasoning models.
 * non-reasoning models.
 *
 * The catalog exercises all five cell states: curated with `off` (kimi-k9),
 * curated without `off` (glm-5.3), curated-none (minimax-m3), reasoning
 * without curation (kimi-k2.7), and no thinking (flash-lite).
 */
const CATALOG: FakeModel[] = [
	{
		slug: "auto",
		displayName: "Auto",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 8_192,
	},
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
		// Curated-none: the explicit empty array survives the wire (omitzero).
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

test("the /model picker shows curated thinking levels and reasoning fallbacks", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-thinking-levels-picker",
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: CATALOG,
			responses: [],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

			terminal.submit("/model")
			await waitForText(terminal, "THINKING", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			const picker = viewText(terminal)
			trace.step("picker open with THINKING column")

			// Column order: CONTEXT, then THINKING, then VISION.
			expect(picker).toContain("CONTEXT")
			expect(picker.indexOf("CONTEXT")).toBeLessThan(picker.indexOf("THINKING"))
			expect(picker.indexOf("THINKING")).toBeLessThan(picker.indexOf("VISION"))

			// Curated catalogs render as comma+space lists in canonical order.
			expect(picker).toContain("low, high, max")
			expect(picker).toContain("off, low, high, max")

			// Curated-none renders on: thinking exists, no distinct levels.
			expect(picker).toMatch(/minimax-m3 {2,}kimchi-dev {2,}\S+ {2,}on {2,}✗/)

			// An uncurated reasoning model shows "not curated" (levels unknown),
			// a non-reasoning model a hard off.
			expect(picker).toMatch(/kimi-k2\.7 {2,}kimchi-dev {2,}\S+ {2,}not curated {2,}✗/)
			expect(picker).toMatch(/flash-lite {2,}kimchi-dev {2,}\S+ {2,}off {2,}✗/)
			trace.step("picker rows show curated and fallback thinking cells")

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		},
	)
})

test("list_models advertises the thinking column with curated and fallback values", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-thinking-levels-tool",
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: CATALOG,
			responses: [
				{
					toolCalls: [{ id: "call_levels", type: "function", function: { name: "list_models", arguments: "{}" } }],
				},
				{ stream: ["Listed."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("List the models")
			await waitForText(terminal, "Listed.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			// The collapsed tool block summarizes ("8 lines returned"); ctrl+o
			// expands to the full listing — the user-visible tool result.
			await waitForText(terminal, "ctrl+o to expand", { timeoutMs: INPUT_TIMEOUT_MS, full: true })
			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "model | context | thinking | vision | reasoning | description", {
				timeoutMs: INPUT_TIMEOUT_MS,
				full: true,
			})
			trace.step("list_models tool result expanded")

			const transcript = fullText(terminal)
			expect(transcript).toContain("model | context | thinking | vision | reasoning | description")
			// Curated levels render canonically regardless of wire order.
			expect(transcript).toContain("off, low, high, max")
			expect(transcript).toContain("low, high, max")
			// Curated-none renders on; uncurated renders "not curated";
			// non-reasoning off.
			expect(transcript).toMatch(/kimchi-dev\/minimax-m3 \| \d+ \| on \| no \| yes/)
			expect(transcript).toMatch(/kimchi-dev\/kimi-k2\.7 \| \d+ \| not curated \| no \| yes/)
			expect(transcript).toMatch(/kimchi-dev\/flash-lite \| \d+ \| off \| no \| no/)
			trace.step("tool table shows thinking cells")
		},
	)
})
