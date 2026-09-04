// ACP integration: a client sends `_meta["kimchi.dev"].appendSystemPrompt` on
// `session/new` — the path an orchestrating ACP client uses to append a role
// instruction to the composed system prompt without touching the binary's CLI
// flags. The key deliberately mirrors `--append-system-prompt` (and pi-mono's
// DefaultResourceLoader option of the same name): the meta value is appended
// to the system prompt, never replacing it — a plain `systemPrompt` key stays
// free for a potential future replace API. Expected: the built binary threads
// the meta value through DefaultResourceLoader into the system prompt of the
// request the model receives. To make the effect client-visible, the fake LLM
// is scripted to obey the injected instruction — it opens its reply with the
// mandatory greeting marker.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"

const GREETING = "CLIENT-GREETING-OK"
const INJECTION =
	`MANDATORY RULE: Begin every reply, before anything else, with exactly this marker: ${GREETING}. ` +
	"Never omit this marker, not even for short answers."

describe("ACP system prompt append via _meta", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "append-system-prompt-meta",
			responses: [
				// The fake LLM "obeys" the injected rule; the assertion that the
				// instruction actually reached the model happens on the recorded
				// request below, so this scripted greeting cannot produce a false
				// positive — without the injection there is nothing in the prompt
				// that would justify it.
				{ stream: [GREETING, " — how can I help?"] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it(
		"appends _meta['kimchi.dev'].appendSystemPrompt from session/new to the model's system prompt",
		async () => {
			const ns = await fixture.conn.newSession({
				cwd: fixture.workDir,
				mcpServers: [],
				_meta: { "kimchi.dev": { appendSystemPrompt: INJECTION } },
			})

			const promptPromise = fixture.conn.prompt({
				sessionId: ns.sessionId,
				prompt: [{ type: "text", text: "Say hi." }],
			})
			const result = await Promise.race([
				promptPromise,
				new Promise<{ stopReason: "TIMEOUT" }>((resolvePromise) =>
					setTimeout(() => resolvePromise({ stopReason: "TIMEOUT" }), PROMPT_TIMEOUT_MS),
				),
			])
			expect(result.stopReason).toBe("end_turn")

			// Client-visible effect: the agent's reply opens with the greeting.
			const chunks = fixture.client.agentTextBySession().get(ns.sessionId) ?? ""
			expect(chunks.startsWith(GREETING), `agent reply should start with the mandatory greeting, got: ${chunks}`).toBe(
				true,
			)

			// Wire-level proof: the chat request the built binary sent to the model
			// carries the appended rule inside its system prompt.
			const chatRequests = fixture.fake.requests.filter((r) => r.url.includes("chat/completions"))
			expect(chatRequests.length).toBeGreaterThan(0)
			const messages = (chatRequests[0].body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
			const systemMessages = messages
				.filter((m) => m.role === "system")
				.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
			const systemPrompt = systemMessages.join("\n")
			expect(systemPrompt, "model-facing system prompt should contain the appended mandatory greeting rule").toContain(
				INJECTION,
			)
		},
		PROMPT_TIMEOUT_MS,
	)
})
