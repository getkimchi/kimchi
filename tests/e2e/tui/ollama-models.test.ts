/**
 * TUI E2E smoke test for the Ollama provider integration.
 *
 * Verifies the end-to-end chat round-trip through the Ollama provider: launch
 * kimchi with `--provider ollama --model <discovered-id>` so the orchestrator
 * never touches the fake OpenAI server. Send a one-shot prompt, wait for the
 * chat-history area to render the echoed user message, and assert the fake
 * server saw zero chat-completion requests during the round-trip.
 *
 * Skipped when no Ollama is reachable — the test is for environments where a
 * developer (or CI runner with Ollama sidecar) has `ollama serve` running.
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

import { test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import {
	BINARY_PATH,
	PACKAGE_DIR,
	PROMPT_READY,
	TUI_TEST_CONFIG,
	createKimchiFixture,
	sh,
	stopKimchi,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

interface OllamaPreflight {
	reachable: boolean
	host: string
	firstModelId: string | undefined
}

/** Resolve $OLLAMA_HOST → default, then probe /api/tags. Returns the first discovered model. */
async function probeOllama(): Promise<OllamaPreflight> {
	const rawHost = process.env.OLLAMA_HOST ?? "http://localhost:11434"
	const host = rawHost.replace(/\/+$/, "")
	try {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 2000)
		const response = await fetch(`${host}/api/tags`, { signal: controller.signal })
		clearTimeout(timeout)
		if (!response.ok) return { reachable: false, host, firstModelId: undefined }
		const body = (await response.json()) as { models?: Array<{ name?: string }> }
		const firstModelId = body.models?.[0]?.name
		return { reachable: true, host, firstModelId }
	} catch {
		return { reachable: false, host, firstModelId: undefined }
	}
}

/** Launch kimchi with the given provider/model overrides (instead of the fake default). */
function launchKimchiAs(
	terminal: Parameters<typeof createKimchiFixture>[0] extends never
		? never
		: import("@microsoft/tui-test/lib/terminal/term.js").Terminal,
	fixture: Awaited<ReturnType<typeof createKimchiFixture>>,
	provider: string,
	model: string,
): void {
	terminal.submit(
		[
			`cd ${sh(fixture.workDir)} &&`,
			"env",
			`HOME=${sh(fixture.homeDir)}`,
			`PI_PACKAGE_DIR=${sh(PACKAGE_DIR)}`,
			"TERM=xterm-256color",
			sh(BINARY_PATH),
			`--provider ${provider}`,
			`--model ${model}`,
		].join(" "),
	)
}

test("chat round-trips through ollama when launched with --provider ollama", async ({ terminal }) => {
	const probe = await probeOllama()
	test.skip(!probe.reachable || !probe.firstModelId, `Ollama not reachable at ${probe.host} (or no models installed)`)
	const discoveredId = probe.firstModelId as string

	const fixture = await createKimchiFixture({
		// One scripted response in case any chat request slips through to the fake
		// server before the orchestrator switches to ollama. Should never be used.
		responses: [{ stream: ["should", " not", " appear"] }],
	})

	try {
		// Launch directly with the ollama provider active. Bypasses the picker so
		// the test is deterministic — no async picker-loading race to fight.
		launchKimchiAs(terminal, fixture, "ollama", discoveredId)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS })

		// Snapshot fake server's chat-completion request count BEFORE sending any prompt.
		const fakeChatRequestsBefore = fixture.fake.requests.filter((request) =>
			request.url.startsWith("/openai/v1/chat/completions"),
		).length

		terminal.submit("Reply with the single word PONG")
		// Wait for the chat-history area to render the echoed user message. This
		// proves kimchi accepted the submit and dispatched the request. We do NOT
		// wait for Ollama's response content (non-deterministic) — the load-bearing
		// assertion is on the fake server's request count below.
		await waitForText(terminal, /PONG/i, { timeoutMs: STREAM_TIMEOUT_MS })

		// Load-bearing assertion: the fake server must NOT have seen a
		// chat-completion request. If it did, the orchestrator routed the prompt
		// to the wrong provider and the integration is broken.
		const fakeChatRequestsAfter = fixture.fake.requests.filter((request) =>
			request.url.startsWith("/openai/v1/chat/completions"),
		).length
		if (fakeChatRequestsAfter !== fakeChatRequestsBefore) {
			throw new Error(
				`Expected zero new chat-completion requests to the fake server when launched with --provider ollama; fake went from ${fakeChatRequestsBefore} to ${fakeChatRequestsAfter}. Latest fake body: ${JSON.stringify(fixture.fake.requests.at(-1)?.body)}`,
			)
		}

		// Also verify models.json contains the ollama provider — proves the
		// startup probe ran end-to-end and would survive subsequent kimchi-dev
		// metadata refreshes (success criterion #2).
		const modelsJsonPath = join(fixture.agentDir, "models.json")
		const persisted = JSON.parse(readFileSync(modelsJsonPath, "utf-8")) as {
			providers?: Record<string, { models?: Array<{ id?: string }> }>
		}
		if (!persisted.providers?.ollama) {
			throw new Error(
				`models.json at ${modelsJsonPath} has no "ollama" provider after startup — startup probe did not run or failed.`,
			)
		}
		const ollamaIds = (persisted.providers.ollama.models ?? []).map((model) => model.id).filter(Boolean)
		if (!ollamaIds.includes(discoveredId)) {
			throw new Error(`models.json ollama provider does not contain ${discoveredId}; got ${JSON.stringify(ollamaIds)}`)
		}
	} finally {
		try {
			await stopKimchi(terminal)
		} catch {
			// best-effort teardown
		}
		try {
			await fixture.stop()
		} catch {
			// best-effort teardown
		}
	}
})
