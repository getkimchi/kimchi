import { expect, test } from "@microsoft/tui-test"
import {
	fullText,
	INPUT_TIMEOUT_MS,
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import {
	createKimchiFixture,
	launchKimchi,
	PROMPT_READY,
	runKimchiSession,
	stopKimchi,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const MODELS = [
	// The backend-routed virtual model and the concrete models it can route to.
	{
		slug: "auto-beta",
		displayName: "Auto Beta",
		provider: "ai-enabler",
		input: ["text"] as const,
		contextWindow: 1_048_576,
		maxTokens: 16_384,
	},
	{
		slug: "kimi-k3",
		displayName: "Kimi K3",
		provider: "ai-enabler",
		input: ["text"] as const,
		contextWindow: 128_000,
		maxTokens: 4_096,
	},
	{
		slug: "glm-5.3-flash",
		displayName: "GLM 5.3 Flash",
		provider: "ai-enabler",
		input: ["text"] as const,
		contextWindow: 128_000,
		maxTokens: 4_096,
	},
]

/** Per-request requested model id captured on the wire. */
function requestModel(body: unknown): string | undefined {
	return body && typeof body === "object" && "model" in body && typeof body.model === "string" ? body.model : undefined
}

function chatRequests(fixture: { fake: { requests: { url: string }[] } }) {
	return fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
}

test("backend-routed auto-beta learns the pick, announces it, and re-routes", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "routed-model-pick-and-reroute",
			providerId: "kimchi-dev",
			initialModel: "auto-beta",
			models: MODELS,
			responses: [
				{ stream: ["First routed reply."], responseModel: "kimi-k3" },
				{ stream: ["Re-routed reply."], responseModel: "glm-5.3-flash" },
			],
		},
		async (fixture, trace) => {
			// Still requests the virtual id on the wire; the backend routes it.
			terminal.submit("Route my first prompt")
			await waitForText(terminal, "First routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "auto-beta picked kimi-k3.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			trace.step("pick notice announced after the first routed response")

			// Second prompt re-routes to a different concrete model.
			terminal.submit("Route this one too")
			await waitForText(terminal, "Re-routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "auto-beta picked glm-5.3-flash.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("reroute announced a changed pick")

			// Both requests asked for auto-beta; the backend routed each to a
			// different concrete model reported in the response `model` field.
			const chat = chatRequests(fixture)
			expect(chat).toHaveLength(2)
			expect(chat.map((request) => requestModel(request.body))).toEqual(["auto-beta", "auto-beta"])
		},
	)
})

test("resuming a backend-routed session restores its requested virtual model", async ({ terminal }) => {
	const exitMarker = "__KIMCHI_ROUTED_MODEL_RESUME_EXITED__"
	const fixture = await createKimchiFixture({
		providerId: "kimchi-dev",
		initialModel: "auto-beta",
		models: MODELS,
		responses: [
			{ stream: ["Left routed reply."], responseModel: "kimi-k3" },
			{ stream: ["Resumed routed reply."], responseModel: "kimi-k3" },
		],
	})

	try {
		launchKimchi(terminal, fixture, [], fixture.seedEnv, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Route before resuming")
		await waitForText(terminal, "Left routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
		await waitForText(terminal, "auto-beta picked kimi-k3.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
		terminal.submit("/session")
		await waitForText(terminal, /ID:\s*[0-9a-f-]{36}/, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		const sessionId = fullText(terminal).match(/ID:\s*([0-9a-f-]{36})/)?.[1]
		expect(sessionId).toBeDefined()
		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		launchKimchi(terminal, fixture, ["-r", sessionId ?? ""], fixture.seedEnv)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Continue the session")
		await waitForText(terminal, "Resumed routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
		// Hydration restored the pick notice on the resumed session.
		await waitForText(terminal, "auto-beta picked kimi-k3.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
		await waitForTurnToSettle(fixture.fake.requests)

		// Honest attribution on resume: every chat request that carries a
		// requested model still names the virtual id (never a concrete pick).
		const requested = chatRequests(fixture)
			.map((request) => requestModel(request.body))
			.filter((m) => m !== undefined)
		expect(requested.length).toBeGreaterThanOrEqual(2)
		expect(requested.every((m) => m === "auto-beta")).toBe(true)
	} finally {
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop().catch(() => {})
	}
})
