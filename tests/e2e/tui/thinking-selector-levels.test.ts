import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import {
	INPUT_TIMEOUT_MS,
	STARTUP_TIMEOUT_MS,
	viewText,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** The fixture unpins every status-line segment to keep terminal layouts
 *  stable; bar-asserting tests pin the thinking segment back on. */
function pinThinkingSegment(homeDir: string): void {
	const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { statusLine?: { pinned?: string[] } }
	writeFileSync(settingsPath, JSON.stringify({ ...settings, statusLine: { pinned: ["thinking"] } }, null, "\t"))
}

/**
 * TUI E2E for the curated-aware /thinking selector and the status line's
 * thinking segment. Selectability comes from /v1/models/metadata
 * (`thinking_levels`) ∩ pi's map-supported set: every canonical level is
 * rendered, the non-selectable ones greyed out (dimmed label, nothing
 * else); models
 * with no selectable levels (curated-none, non-reasoning) show a warning info
 * line, the typed /thinking <level> path errors informatively, and the
 * bottom bar shows `on` / `off` instead of a meaningless level.
 *
 * The catalog mirrors model-thinking-levels.test.ts: curated glm-5.3
 * (low/high/max — the ai-enabler map keeps all three selectable),
 * curated-none minimax-m3, uncurated reasoning kimi-k2.7, non-reasoning
 * flash-lite.
 */
const CATALOG: FakeModel[] = [
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

test("the /thinking selector greys out non-curated levels and selects curated ones", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-selector-curated",
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: CATALOG,
			responses: [{ stream: ["Curated reply."] }],
			seedHome: (homeDir) => pinThinkingSegment(homeDir),
		},
		async (fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

			// Startup clamps the default (medium) into the curated set (upward
			// first): high. The bar never shows an unselectable level.
			await waitForText(terminal, "thinking:high", { timeoutMs: INPUT_TIMEOUT_MS, full: false })

			terminal.submit("/thinking")
			await waitForText(terminal, "Thinking Level", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			const selector = viewText(terminal)
			trace.step("selector open with every canonical level")

			// No model-level info line — levels ARE selectable here.
			expect(selector).not.toContain("provider default")
			expect(selector).not.toContain("does not support thinking")

			// Current level marked; greying is the only signal — no extra
			// markers or suffixes on the non-selectable levels.
			expect(selector).toContain("✓ high")
			expect(selector).not.toContain("✗")
			expect(selector).not.toContain("unavailable")
			trace.step("non-selectable levels are only greyed out")

			// Arrow navigation jumps over greyed-out levels: one Down from
			// high skips the disabled xhigh and lands on max.
			terminal.write("\x1b[B")
			await waitForText(terminal, /→\s+max/, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toMatch(/→\s+xhigh/)
			trace.step("arrow navigation skips greyed-out levels")

			// Selecting a curated level: type it into the search, Enter.
			terminal.submit("low")
			await waitForText(terminal, "Thinking level: low", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "thinking:low", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("selected curated level low; bar updated")

			// The selected level is what goes on the wire.
			terminal.submit("Say ok")
			await waitForText(terminal, "Curated reply.", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			const chat = fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
			expect(chat).toHaveLength(1)
			expect(chat[0]?.body).toMatchObject({ model: "glm-5.3", reasoning_effort: "low" })
			trace.step("request carries the selected curated effort")
		},
	)
})

test("/thinking <level> rejects levels outside the curated set", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-selector-typed-reject",
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: CATALOG,
			responses: [],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

			terminal.submit("/thinking minimal")
			await waitForText(terminal, "not available for this model", { timeoutMs: INPUT_TIMEOUT_MS })
			const view = viewText(terminal)
			expect(view).toContain('Thinking level "minimal" is not available for this model')
			expect(view).toContain("Available levels: low, high, max")
			trace.step("typed non-curated level rejected with the selectable list")
		},
	)
})

test("curated-none models explain the provider default, reject every level, and render on in the bar", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-selector-curated-none",
			providerId: "kimchi-dev",
			initialModel: "minimax-m3",
			models: CATALOG,
			responses: [{ stream: ["None reply."] }],
			seedHome: (homeDir) => pinThinkingSegment(homeDir),
		},
		async (fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

			// Thinking exists but offers no distinct levels: the bar shows the
			// provider-default state, not a meaningless session level.
			await waitForText(terminal, "thinking:on", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain("thinking:medium")

			// /thinking opens the selector with every level greyed out and an
			// explanation: nothing is selectable, Escape returns.
			terminal.submit("/thinking")
			await waitForText(terminal, "Thinking Level", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			const selector = viewText(terminal)
			expect(selector).toContain("This model does not support selecting thinking levels, press ESC to return")
			expect(selector).toContain("to return")
			expect(selector).not.toContain("Enter to select")
			expect(selector).not.toContain("✓ ")
			trace.step("selector explains the provider default; escape to return")

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS, full: false })

			terminal.submit("/thinking high")
			await waitForText(terminal, "Thinking level not selectable", { timeoutMs: INPUT_TIMEOUT_MS })
			// The toast wraps at the message width, so tolerate line breaks.
			expect(viewText(terminal)).toMatch(/always\s+reasons\s+at\s+the\s+provider\s+default/)
			trace.step("typed level rejected with the none-mode explanation")

			// The provider default is also what goes on the wire: no explicit
			// effort at all — neither the stale session level nor a "none".
			terminal.submit("Say ok")
			await waitForText(terminal, "None reply.", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			const chat = fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
			expect(chat).toHaveLength(1)
			expect(chat[0]?.body).not.toHaveProperty("reasoning_effort")
			trace.step("request carries no explicit effort")
		},
	)
})

test("non-reasoning models render off in the bar and explain the absence of levels", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-selector-no-reasoning",
			providerId: "kimchi-dev",
			initialModel: "flash-lite",
			models: CATALOG,
			responses: [],
			seedHome: (homeDir) => pinThinkingSegment(homeDir),
		},
		async (_fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

			await waitForText(terminal, "thinking:off", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain("thinking:medium")

			terminal.submit("/thinking")
			await waitForText(terminal, "This model does not support thinking, press ESC to return", {
				timeoutMs: INPUT_TIMEOUT_MS,
				full: false,
			})
			expect(viewText(terminal)).toContain("to return")
			expect(viewText(terminal)).not.toContain("Enter to select")
			trace.step("bare /thinking shows the no-thinking status without a selector")
		},
	)
})

test("uncurated models keep pi's computed set selectable", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-selector-uncurated",
			providerId: "kimchi-dev",
			initialModel: "kimi-k2.7",
			models: CATALOG,
			responses: [],
			seedHome: (homeDir) => pinThinkingSegment(homeDir),
		},
		async (_fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

			// Uncurated: the session level is meaningful; nothing is clamped.
			await waitForText(terminal, "thinking:medium", { timeoutMs: INPUT_TIMEOUT_MS, full: false })

			terminal.submit("/thinking")
			await waitForText(terminal, "Thinking Level", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			const selector = viewText(terminal)
			// pi's map-based set: off..high plus max (ai-enabler map), with
			// only xhigh beyond the wire format's confirmation — greyed out,
			// no other signal.
			expect(selector).toContain("✓ medium")
			expect(selector).not.toContain("✗")
			expect(selector).not.toContain("unavailable")

			// Two Downs from medium: high is selectable, then the greyed-out
			// xhigh is skipped and the cursor lands on max.
			terminal.write("\x1b[B")
			await waitForText(terminal, /→\s+high/, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.write("\x1b[B")
			await waitForText(terminal, /→\s+max/, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toMatch(/→\s+xhigh/)
			trace.step("uncurated model keeps pi's set; navigation skips xhigh")
		},
	)
})

test("switching models re-clamps the thinking level through curated-none", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-selector-switch-clamp",
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: CATALOG,
			responses: [],
			seedHome: (homeDir) => pinThinkingSegment(homeDir),
		},
		async (_fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

			// Startup clamp: the default (medium) rank-clamps upward into the
			// curated set (low/high/max).
			await waitForText(terminal, "thinking:high", { timeoutMs: INPUT_TIMEOUT_MS, full: false })

			// Switching to the curated-none model settles the level on off — the
			// bar shows the provider-default state, not the previous level.
			terminal.submit("/model kimchi-dev/minimax-m3")
			await waitForText(terminal, "thinking:on", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain("thinking:high")
			trace.step("switch to curated-none shows on")

			// Switching back rank-clamps from off into the curated set (upward
			// first): low — not the pre-switch high, which is what a bypassed
			// clamp would keep.
			terminal.submit("/model kimchi-dev/glm-5.3")
			await waitForText(terminal, "thinking:low", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain("thinking:high")
			trace.step("switch back re-clamps into the curated set")
		},
	)
})
