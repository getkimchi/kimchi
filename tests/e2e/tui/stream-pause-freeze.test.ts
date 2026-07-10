import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, fullText, viewText, waitForText } from "./support/assertions.js"
import {
	PROMPT_READY,
	TUI_TEST_CONFIG,
	createKimchiFixture,
	launchKimchi,
	stopKimchi,
} from "./support/kimchi-fixture.js"
import type { FakeResponseScript } from "./support/fake-openai-server.js"

test.use(TUI_TEST_CONFIG)

const COOKING_MSG =
	/Stirring|Marinating|Chopping|Mixing|Salting|Grinding|Packing|Massaging|Reducing|Prepping|Simmering|Chilling|Seasoning|Tasting|Letting it rest|Rinsing|Building the brine|Cooking|Braising|Tossing/

/**
 * Reproduces the freeze/unresumable-session bug reported in LLM-2477.
 *
 * A fake LLM server streams the first chunk immediately, then pauses for a
 * long time before the second chunk (simulating a stalled LLM). The harness
 * should remain responsive to Escape (abort). After abort, the session
 * must be resumable with -r and accept a follow-up prompt.
 */
test("session survives mid-stream pause and remains resumable after abort", async ({ terminal }) => {
	// Match only the LAST user message in the request body, so startup/title
	// calls (which include system prompt text) don't consume our scripts.
	const matchLastUserMessage = (req: { body: unknown }, text: string) => {
		try {
			const body = req.body as Record<string, unknown>
			const messages = body?.messages as Array<{ role: string; content: string | Array<{ text?: string }> }>
			if (!Array.isArray(messages)) return false
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role !== "user") continue
				const content = messages[i].content
				if (typeof content === "string") return content.includes(text)
				if (Array.isArray(content))
					return content.some((c) => typeof c.text === "string" && c.text.includes(text))
				return false
			}
			return false
		} catch {
			return false
		}
	}

	const stallScript: FakeResponseScript = {
		match: (req) => matchLastUserMessage(req, "Tell me something"),
		stream: ["Partial response", "…"],
		streamChunkDelays: [0, 60_000], // chunk 0 immediate, chunk 1 stalls
	}

	const followUpScript: FakeResponseScript = {
		match: (req) => matchLastUserMessage(req, "continue"),
		stream: ["Follow-up after resume"],
	}

	const defaultScript: FakeResponseScript = { stream: ["ok"] }

	// Match-based scripts must come BEFORE defaults in the queue.
	// takeNextResponse scans left-to-right and splices the first match.
	// A script with no `match` predicate matches everything, so it must
	// come last to avoid shadowing the specific scripts.
	const fixture = await createKimchiFixture({
		responses: [stallScript, followUpScript, defaultScript, defaultScript, defaultScript, defaultScript, defaultScript, defaultScript, defaultScript],
	})

	try {
		launchKimchi(terminal, fixture)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		// Send a prompt that triggers the stalled streaming response
		terminal.submit("Tell me something")

		// Wait for the first chunk of the stalled response to appear
		await waitForText(terminal, "Partial response", { timeoutMs: STREAM_TIMEOUT_MS })

		// The server is now paused mid-stream (60s delay before chunk 2)
		await new Promise((resolve) => setTimeout(resolve, 2_000))

		// Verify the cooking animation is spinning (agent is streaming)
		const viewBeforeAbort = viewText(terminal)
		expect(viewBeforeAbort).toMatch(COOKING_MSG)

		// Press Escape to abort the stream
		terminal.keyEscape()

		// Wait for the cooking animation to disappear — this proves the agent
		// became idle. If the harness is frozen, the spinner stays forever.
		const startedAt = Date.now()
		let view = viewText(terminal)
		while (Date.now() - startedAt < 15_000) {
			view = viewText(terminal)
			if (!COOKING_MSG.test(view)) break
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		if (COOKING_MSG.test(view)) {
			throw new Error(`Cooking animation still spinning after 15s — harness is frozen.\n\nTerminal:\n${view}`)
		}

		// After abort, restoreQueuedMessagesToEditor may have put the queued
		// steering message back into the editor. Clear it with Ctrl+U (kill line).
		terminal.write("\x15")
		await new Promise((resolve) => setTimeout(resolve, 200))

		// Now the agent should be idle. Get the session ID for resume.
		terminal.submit("/session")
		await waitForText(terminal, /ID:\s*[0-9a-f-]{36}/, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		const match = fullText(terminal).match(/ID:\s*([0-9a-f-]{36})/)
		expect(match).not.toBeNull()
		const sessionId = match![1]

		// Quit
		terminal.submit("/quit")
		await new Promise((resolve) => setTimeout(resolve, 1_000))

		// Resume the session — if the session file is unresumable, this hangs
		launchKimchi(terminal, fixture, ["-r", sessionId])
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		// Verify session history is intact
		await waitForText(terminal, "Partial response", { timeoutMs: STARTUP_TIMEOUT_MS })

		// Send a follow-up to confirm the session is fully functional
		terminal.submit("continue")
		await waitForText(terminal, "Follow-up after resume", { timeoutMs: STREAM_TIMEOUT_MS })
	} finally {
		try {
			await stopKimchi(terminal)
		} catch {
			/* best-effort */
		}
		try {
			await fixture.stop()
		} catch {
			/* best-effort */
		}
	}
})
