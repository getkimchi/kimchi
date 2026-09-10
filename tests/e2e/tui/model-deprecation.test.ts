import { expect, test } from "@microsoft/tui-test"
import { fullText, INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Keep fixtures inside the 30-day deprecation notice window regardless of when the suite runs.
const DEPRECATED_AT_30D = new Date(Date.now() + 30 * 86_400_000).toISOString()
const DEPRECATED_DATE_30D = DEPRECATED_AT_30D.slice(0, 10)

/**
 * TUI E2E for model deprecation awareness (LLM deprecation protocol).
 *
 * The fake metadata endpoint serves announced-deprecated models, so a session
 * opening on one must surface the retirement warning with the replacement
 * hint — exactly what the user sees when a Kimchi model enters its
 * deprecation window. The warning is a persistent notification deduplicated
 * per model per session.
 */

test("session start on an announced-deprecated model warns with retirement date and replacement", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-deprecation-session-start",
			models: [
				{
					slug: "fake-old",
					displayName: "Fake Old",
					contextWindow: 1_000_000,
					maxTokens: 4096,
					metadata: {
						deprecated_at: DEPRECATED_AT_30D,
						replacement_model: "fake-new",
					},
				},
				{ slug: "fake-new", displayName: "Fake New", contextWindow: 1_000_000, maxTokens: 4096 },
			],
			initialModel: "fake-old",
			responses: [],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, `"fake-old" is deprecated and will be retired on ${DEPRECATED_DATE_30D}`, {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("deprecation warning visible")
			// The notification wraps at the terminal width — assert contiguous
			// fragments so line breaks can't split a longer expected string.
			await waitForText(terminal, 'Switch to "fake-new"', { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "for better", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("replacement hint visible")
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("prompt ready")
		},
	)
})

test("session start on an announced-deprecated model without a replacement uses the fallback hint", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-deprecation-no-replacement",
			models: [
				{
					slug: "fake-old",
					displayName: "Fake Old",
					contextWindow: 1_000_000,
					maxTokens: 4096,
					metadata: { deprecated_at: DEPRECATED_AT_30D },
				},
			],
			initialModel: "fake-old",
			responses: [],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, `"fake-old" is deprecated and will be retired on ${DEPRECATED_DATE_30D}`, {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("deprecation date visible")
			// The notification wraps at the terminal width — assert contiguous
			// fragments so line breaks can't split a longer expected string.
			await waitForText(terminal, "It may be removed in a future update.", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("fallback deprecation warning visible")
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("prompt ready")
		},
	)
})

test("session start on an active model shows no deprecation warning", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-deprecation-active-model",
			models: [{ slug: "fake-old", displayName: "Fake Old", contextWindow: 1_000_000, maxTokens: 4096 }],
			initialModel: "fake-old",
			responses: [],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("prompt ready")
			await expect(terminal.getByText("is deprecated")).not.toBeVisible()
			trace.step("no deprecation warning")
		},
	)
})

test("cycling to a deprecated model shows the retirement warning", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-deprecation-cycle-onto-deprecated",
			models: [
				{ slug: "fake-active", displayName: "Fake Active", contextWindow: 1_000_000, maxTokens: 4096 },
				{
					slug: "fake-old",
					displayName: "Fake Old",
					contextWindow: 1_000_000,
					maxTokens: 4096,
					metadata: { deprecated_at: DEPRECATED_AT_30D },
				},
			],
			initialModel: "fake-active",
			responses: [],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("prompt ready")
			// Ctrl+P cycles to the next model: its retirement warning fires on selection.
			terminal.keyPress("p", { ctrl: true })
			await waitForText(terminal, `"fake-old" is deprecated and will be retired on ${DEPRECATED_DATE_30D}`, {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("cycle-in warning visible")
		},
	)
})

test("a transparently re-routed response warns about the substitution", async ({ terminal }) => {
	// The gateway rewrites retired-model requests to the curated replacement
	// and annotates the response with X-Model-Requested / X-Model-Actual (plus
	// Deprecation/Sunset dates). The fake server scripts those headers on an
	// ordinary reply; the catalog here knows nothing about any deprecation —
	// the warning is driven purely by the response headers.
	const sunsetAt = new Date(Date.now() + 30 * 86_400_000)
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-deprecation-substitution",
			models: [
				{ slug: "fake-old", displayName: "Fake Old", contextWindow: 1_000_000, maxTokens: 4096 },
				{ slug: "fake-new", displayName: "Fake New", contextWindow: 1_000_000, maxTokens: 4096 },
			],
			initialModel: "fake-old",
			responses: [
				{
					stream: ["Substituted reply."],
					headers: {
						"X-Model-Requested": "fake-old",
						"X-Model-Actual": "fake-new",
						Sunset: sunsetAt.toUTCString(),
					},
				},
			],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("prompt ready")
			terminal.submit("Say something")
			await waitForText(terminal, "Substituted reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("reply received")
			// The notification wraps at the terminal width — assert contiguous
			// fragments so line breaks can't split a longer expected string.
			await waitForText(terminal, '"fake-old" is being transparently served as "fake-new"', {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			await waitForText(terminal, `until ${sunsetAt.toUTCString().slice(0, 10)}`, {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("substitution warning visible")
		},
	)
})

test("cycling back onto a deprecated model does not re-fire its warning", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-deprecation-cycle-back-deduped",
			models: [
				{ slug: "fake-active", displayName: "Fake Active", contextWindow: 1_000_000, maxTokens: 4096 },
				{
					slug: "fake-old",
					displayName: "Fake Old",
					contextWindow: 1_000_000,
					maxTokens: 4096,
					metadata: { deprecated_at: DEPRECATED_AT_30D },
				},
			],
			initialModel: "fake-active",
			responses: [],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("prompt ready")
			// Cycle onto the deprecated model: the warning fires once.
			terminal.keyPress("p", { ctrl: true })
			await waitForText(terminal, "is deprecated and will be retired", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("warning fired on deprecated model")
			// Cycle to the active model, then back onto the deprecated one. The
			// warning is a persistent record deduplicated per model per session,
			// so it must not fire again.
			terminal.keyPress("p", { ctrl: true })
			await new Promise((resolve) => setTimeout(resolve, 800))
			terminal.keyPress("p", { ctrl: true })
			await new Promise((resolve) => setTimeout(resolve, 1_200))
			const occurrences = fullText(terminal).split("is deprecated and will be retired").length - 1
			expect(occurrences).toBe(1)
			trace.step("warning not re-fired after cycling back")
		},
	)
})
