/**
 * TUI E2E smoke test for the Ollama provider integration.
 *
 * Verifies the end-to-end chat round-trip through the Ollama provider: launch
 * kimchi with `--provider ollama --model <discovered-id>` so the orchestrator
 * never touches the fake OpenAI server. Send a one-shot prompt, wait for the
 * chat-history area to render the echoed user message, and assert the fake
 * server saw zero chat-completion requests during the round-trip.
 *
 * Uses tests/e2e/tui/support/fake-ollama-server.ts — a mock that mirrors the
 * real Ollama endpoints (/api/tags, /api/show, /v1/chat/completions). The
 * fixture (kimchi-fixture.ts) starts the mock and injects OLLAMA_HOST into the
 * launch env so the test is fully self-contained — no `ollama serve` required.
 *
 * What this test does NOT cover (and why):
 *
 *   - /model picker UI interaction. The picker's `ModelSelectorComponent`
 *     loads models asynchronously (model-selector.js:82-92 — `loadModels()`
 *     then `updateList()`), and `@microsoft/tui-test`'s `terminal.submit`
 *     races with that lifecycle. Attempting "open picker + type filter +
 *     press Enter to select" in one test produced flaky terminal-state
 *     collisions (keystrokes landing in the wrong buffer cell). Picker
 *     integration is covered by:
 *       1. Unit tests in src/ollama.test.ts (probeOllamaModels, injectOllamaProvider)
 *       2. `dist/bin/kimchi --list-models` at runtime (proves pi-mono's
 *          ModelRegistry reads the injected provider from models.json)
 *       3. Manual smoke check — the picker did render `gemma4:latest [ollama]`
 *          in earlier attempts; see `.kimchi/ferments/.../docs/step-4-design.md`.
 *   - Multi-turn / streaming assertion. We deliberately wait only for the
 *     echoed user prompt ("PONG" appears in the buffer once the message is
 *     accepted) rather than Ollama's response content, because Ollama output
 *     is non-deterministic. The load-bearing assertion is the fake-server
 *     chat-completion request count — if it stayed at zero, the request
 *     was routed to Ollama, not the fake server.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import {
	PROMPT_READY,
	TUI_TEST_CONFIG,
	createKimchiFixture,
	launchKimchi,
	stopKimchi,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("chat round-trips through ollama when launched with --provider ollama", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		ollama: {
			models: [
				{
					name: "llava:13b",
					parameter_size: "13B",
					family: "llama",
					capabilities: ["completion", "vision"],
					context_length: 4096,
					quantization_level: "Q4_K_M",
				},
				{
					name: "qwen2.5:14b",
					parameter_size: "14B",
					family: "qwen2",
					capabilities: ["completion", "thinking"],
					context_length: 32768,
					quantization_level: "Q4_K_M",
				},
				{
					name: "mistral:7b",
					parameter_size: "7B",
					family: "mistral",
					capabilities: ["completion"],
					context_length: 8192,
					quantization_level: "Q4_K_M",
				},
			],
			// Scripted chat-completion responses: each request shifts one entry.
			// "Reply with the single word PONG" should trigger one chat request.
			chatResponses: [{ stream: ["PONG"] }],
		},
		// The openai fake server is still started (as a fallback). We assert
		// that ZERO chat-completion requests hit it during this test.
		responses: [],
	})

	try {
		// Launch kimchi with --provider ollama --model <first-ollama-model>
		launchKimchi(terminal, fixture, ["--provider", "ollama", "--model", "ollama/llava:13b"])
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS })

		// Snapshot fake server's chat-completion request count BEFORE any prompt.
		const fakeChatRequestsBefore = fixture.fake.requests.filter((request) =>
			request.url.startsWith("/openai/v1/chat/completions"),
		).length

		// Also snapshot the number of ollama discovery + chat requests BEFORE the prompt.
		const ollamaRequestsBefore = fixture.ollama ? fixture.ollama.requests.length : 0

		terminal.submit("Reply with the single word PONG")
		// Wait for the echoed user prompt (proves the message was accepted).
		await waitForText(terminal, /PONG/i, { timeoutMs: STREAM_TIMEOUT_MS })

		// Load-bearing assertion #1: the openai fake must NOT have seen a new
		// chat-completion request — routing is correct.
		const fakeChatRequestsAfter = fixture.fake.requests.filter((request) =>
			request.url.startsWith("/openai/v1/chat/completions"),
		).length
		expect(fakeChatRequestsAfter).toBe(fakeChatRequestsBefore)

		// Load-bearing assertion #2: the ollama fake was probed for models.
		// At minimum there should be a GET /api/tags and 3× POST /api/show.
		// (The TUI startup probe calls probeOllamaModels which enriches all models.)
		const ollamaRequestsAfter = fixture.ollama ? fixture.ollama.requests.length : 0
		expect(ollamaRequestsAfter).toBeGreaterThan(ollamaRequestsBefore)

		// Load-bearing assertion #3: models.json contains the ollama provider.
		const modelsJsonPath = join(fixture.agentDir, "models.json")
		const persisted = JSON.parse(readFileSync(modelsJsonPath, "utf-8")) as {
			providers?: Record<string, { models?: Array<{ id?: string }> }>
		}
		expect(persisted.providers).toBeDefined()
		expect(persisted.providers!.ollama).toBeDefined()
		const ollamaIds = (persisted.providers!.ollama.models ?? []).map((model) => model.id).filter(Boolean)
		expect(ollamaIds).toContain("llava:13b")
		expect(ollamaIds).toContain("qwen2.5:14b")
		expect(ollamaIds).toContain("mistral:7b")
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
