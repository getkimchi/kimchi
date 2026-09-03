import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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
	{
		slug: "routed",
		displayName: "Fake Routed",
		provider: "ai-enabler",
		input: ["text"] as const,
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
]

const MODELS_WITH_OVERRIDE = [
	...MODELS,
	{
		slug: "override",
		displayName: "Fake Override",
		provider: "ai-enabler",
		input: ["text"] as const,
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
]

const ROUTED_ROUTER_RESPONSE = { best_model: "routed", probabilities: { routed: 1 } }

const MODELS_WITH_RANKED_FALLBACK = [
	...MODELS,
	{
		slug: "fallback",
		displayName: "Fake Ranked Fallback",
		provider: "ai-enabler",
		input: ["text"] as const,
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
]

function requestsTo<T extends { url: string }>(fixture: { fake: { requests: T[] } }, path: string): T[] {
	return fixture.fake.requests.filter((request) => request.url.startsWith(path))
}

async function waitForRequest(
	fixture: { fake: { requests: { url: string }[] } },
	path: string,
	minimumCount = 1,
	timeoutMs = INPUT_TIMEOUT_MS,
): Promise<void> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		if (requestsTo(fixture, path).length >= minimumCount) return
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`Timed out waiting for a request to ${path}`)
}

async function waitForAbortedRequest(
	fixture: { fake: { requests: { url: string; aborted: boolean }[] } },
	path: string,
	timeoutMs = 2_000,
): Promise<void> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		if (requestsTo(fixture, path).some((request) => request.aborted)) return
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`Timed out waiting for the request to ${path} to be aborted`)
}

async function navigateToSetting(terminal: import("@microsoft/tui-test").Terminal, label: string): Promise<void> {
	for (let index = 0; index < 30; index += 1) {
		const cursorLine = viewText(terminal)
			.split("\n")
			.find((line) => line.includes("→"))
		if (cursorLine?.includes(label)) {
			terminal.submit("")
			return
		}
		terminal.keyDown()
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`Could not navigate to setting "${label}"`)
}

function requestModel(body: unknown): string | undefined {
	return body && typeof body === "object" && "model" in body && typeof body.model === "string" ? body.model : undefined
}

function agentCall(id: string, model?: string, runInBackground = false) {
	return {
		id,
		function: {
			name: "Agent",
			arguments: JSON.stringify({
				prompt: "Return the words child route complete",
				description: "verify child routing",
				subagent_type: "General-Purpose",
				...(model ? { model } : {}),
				...(runInBackground ? { run_in_background: true } : {}),
			}),
		},
	}
}

test("/model autocomplete shows and selects Auto when experimental features are enabled", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-autocomplete-selection",
			providerId: "kimchi-dev",
			initialModel: "routed",
			extraArgs: ["--enable-experimental-features"],
			models: MODELS,
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/model")
			await waitForText(terminal, "/model", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "Only showing models from configured providers", {
				timeoutMs: INPUT_TIMEOUT_MS,
				full: false,
			})
			trace.step("model autocomplete open")

			terminal.write("auto")
			await waitForText(terminal, "Auto (Kimchi Router)", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).toMatch(/→ auto \[kimchi-dev\]/)
			trace.step("Auto highlighted")

			terminal.submit("")
			await waitForText(terminal, "Model: auto", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "auto → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("Auto selected")
		},
	)
})

test("Auto routes once and keeps the selected concrete model for the session", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-routes-once",
			providerId: "kimchi-dev",
			initialModel: "auto",
			extraArgs: ["--enable-experimental-features"],
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE],
			responses: [{ stream: ["First routed reply."] }, { stream: ["Second routed reply."] }],
		},
		async (fixture, trace) => {
			terminal.submit("Choose a model for this session")
			await waitForText(terminal, "First routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "auto (routed) → ctrl+p", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("first prompt routed")

			terminal.submit("Keep using it")
			await waitForText(terminal, "Second routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			const routerRequests = requestsTo(fixture, "/v1/route")
			expect(routerRequests).toHaveLength(1)
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests).toHaveLength(2)
			expect(chatRequests.map((request) => requestModel(request.body))).toEqual(["routed", "routed"])
			expect(routerRequests[0]?.headers["x-session-id"]).toBe(chatRequests[0]?.headers["x-session-id"])
			expect(routerRequests[0]?.headers["x-conversation-id"]).toBe(chatRequests[0]?.headers["x-conversation-id"])
			expect(routerRequests[0]?.headers["x-turn-index"]).toBe(chatRequests[0]?.headers["x-turn-index"])
			expect(routerRequests[0]?.headers.traceparent).toBe(chatRequests[0]?.headers.traceparent)
			expect(routerRequests[0]?.headers["x-parent-session-id"]).toBeUndefined()

			const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8"))
			expect(settings.defaultProvider).toBe("kimchi-dev")
			expect(settings.defaultModel).toBe("auto")
		},
	)
})

test("Auto exposes only off after routing to a model without reasoning", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-non-reasoning-controls",
			providerId: "kimchi-dev",
			initialModel: "auto",
			extraArgs: ["--enable-experimental-features"],
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE],
			responses: [{ stream: ["Non-reasoning reply."] }],
		},
		async (fixture) => {
			terminal.submit("Route to the plain model")
			await waitForText(terminal, "Non-reasoning reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			terminal.write("/settings")
			await waitForText(terminal, "/settings", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "Auto-compact", { timeoutMs: INPUT_TIMEOUT_MS })
			await navigateToSetting(terminal, "Thinking level")
			await waitForText(terminal, "Enter to select · Esc to go back", { timeoutMs: INPUT_TIMEOUT_MS })

			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, "Enter/Space to change · Esc to cancel", { timeoutMs: INPUT_TIMEOUT_MS })
			const thinkingLine = viewText(terminal)
				.split("\n")
				.find((line) => line.includes("Thinking level"))
			expect(thinkingLine).toMatch(/Thinking level\s+off/)

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		},
	)
})

test("Auto uses the highest-ranked eligible model when the best model is outside the active scope", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-ranked-scoped-fallback",
			providerId: "kimchi-dev",
			initialModel: "auto",
			extraArgs: ["--enable-experimental-features", "--models", "kimchi-dev/fallback"],
			models: MODELS_WITH_RANKED_FALLBACK,
			routerResponses: [{ best_model: "routed", probabilities: { routed: 0.9, fallback: 0.7 } }],
			responses: [{ stream: ["Ranked fallback reply."] }],
		},
		async (fixture) => {
			terminal.submit("Use the first eligible router-ranked model")
			await waitForText(terminal, "Ranked fallback reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "auto (fallback) → ctrl+p", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			expect(requestsTo(fixture, "/v1/route")).toHaveLength(1)
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests).toHaveLength(1)
			expect(requestModel(chatRequests[0]?.body)).toBe("fallback")
		},
	)
})

test("Auto stops an unavailable-router prompt and retries when the user submits again", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-router-unavailable",
			providerId: "kimchi-dev",
			initialModel: "auto",
			extraArgs: ["--enable-experimental-features"],
			models: MODELS,
			routerResponses: [undefined, ROUTED_ROUTER_RESPONSE],
			responses: [{ stream: ["Router retry succeeded."] }],
		},
		async (fixture) => {
			terminal.submit("Try while the router is unavailable")
			await waitForText(terminal, "Auto is unavailable", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "/model", { timeoutMs: STREAM_TIMEOUT_MS })

			expect(requestsTo(fixture, "/v1/route")).toHaveLength(1)
			expect(requestsTo(fixture, "/openai/v1/chat/completions")).toHaveLength(0)

			terminal.submit("Try the router again")
			await waitForText(terminal, "Router retry succeeded.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "auto (routed) → ctrl+p", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			expect(requestsTo(fixture, "/v1/route")).toHaveLength(2)
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests).toHaveLength(1)
			expect(requestModel(chatRequests[0]?.body)).toBe("routed")
		},
	)
})

test("Escape cancels an in-flight router request and the corrected prompt can route", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-router-cancellation",
			providerId: "kimchi-dev",
			initialModel: "auto",
			extraArgs: ["--enable-experimental-features"],
			models: MODELS,
			responses: [{ stream: ["Corrected prompt succeeded."] }],
			routerResponses: [ROUTED_ROUTER_RESPONSE, ROUTED_ROUTER_RESPONSE],
			stallRouterRequestNumber: 1,
		},
		async (fixture, trace) => {
			terminal.submit("Cancel this routing request")
			await waitForRequest(fixture, "/v1/route")
			trace.step("router request in flight")

			terminal.keyEscape()
			await waitForAbortedRequest(fixture, "/v1/route")
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("Escape restored the prompt")

			expect(requestsTo(fixture, "/v1/route")).toHaveLength(1)
			expect(requestsTo(fixture, "/openai/v1/chat/completions")).toHaveLength(0)

			terminal.submit("Use this corrected prompt instead")
			await waitForText(terminal, "Corrected prompt succeeded.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "auto (routed) → ctrl+p", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			expect(requestsTo(fixture, "/v1/route")).toHaveLength(2)
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests).toHaveLength(1)
			expect(requestModel(chatRequests[0]?.body)).toBe("routed")
		},
	)
})

test("Escape cancels an inherited Auto child while it is routing", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-child-router-cancellation",
			providerId: "kimchi-dev",
			initialModel: "auto",
			extraArgs: ["--enable-experimental-features"],
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE, ROUTED_ROUTER_RESPONSE],
			stallRouterRequestNumber: 2,
			responses: [{ toolCalls: [agentCall("call_cancelled_auto_child")] }],
		},
		async (fixture, trace) => {
			terminal.submit("Delegate and then let me cancel the child")
			await waitForRequest(fixture, "/v1/route", 2, STREAM_TIMEOUT_MS)
			trace.step("child router request in flight")

			terminal.keyEscape()
			await waitForAbortedRequest(fixture, "/v1/route")
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("Escape restored the parent prompt")

			expect(requestsTo(fixture, "/v1/route")).toHaveLength(2)
			expect(requestsTo(fixture, "/openai/v1/chat/completions")).toHaveLength(1)
		},
	)
})

test("a saved Auto default keeps working without the experimental flag", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-saved-default",
			providerId: "kimchi-dev",
			initialModel: false,
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE],
			responses: [{ stream: ["Saved Auto still works."] }],
			seedHome: (homeDir) => {
				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
				writeFileSync(
					settingsPath,
					JSON.stringify({ ...settings, defaultProvider: "kimchi-dev", defaultModel: "auto" }, null, "\t"),
				)
			},
		},
		async (fixture) => {
			terminal.submit("Use my saved model")
			await waitForText(terminal, "Saved Auto still works.", { timeoutMs: STREAM_TIMEOUT_MS })

			expect(requestsTo(fixture, "/v1/route")).toHaveLength(1)
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests).toHaveLength(1)
			expect(requestModel(chatRequests[0]?.body)).toBe("routed")
		},
	)
})

test("resuming an Auto session reuses its concrete resolution without the flag", async ({ terminal }) => {
	const exitMarker = "__KIMCHI_AUTO_RESUME_FIRST_SESSION_EXITED__"
	const fixture = await createKimchiFixture({
		providerId: "kimchi-dev",
		initialModel: "auto",
		models: MODELS,
		routerResponses: [ROUTED_ROUTER_RESPONSE],
		responses: [{ stream: ["Initial Auto reply."] }, { stream: ["Resumed Auto reply."] }],
	})

	try {
		launchKimchi(terminal, fixture, ["--enable-experimental-features"], fixture.seedEnv, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		terminal.submit("Resolve Auto now")
		await waitForText(terminal, "Initial Auto reply.", { timeoutMs: STREAM_TIMEOUT_MS })
		terminal.submit("/session")
		await waitForText(terminal, /ID:\s*[0-9a-f-]{36}/, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		const sessionId = fullText(terminal).match(/ID:\s*([0-9a-f-]{36})/)?.[1]
		expect(sessionId).toBeDefined()

		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		fixture.initialModel = false
		launchKimchi(terminal, fixture, ["-r", sessionId ?? ""], fixture.seedEnv)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		await waitForText(terminal, "auto (routed) → ctrl+p", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Continue the same session")
		await waitForText(terminal, "Resumed Auto reply.", { timeoutMs: STREAM_TIMEOUT_MS })
		await waitForTurnToSettle(fixture.fake.requests)

		expect(requestsTo(fixture, "/v1/route")).toHaveLength(1)
		const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
		expect(chatRequests).toHaveLength(2)
		expect(chatRequests.map((request) => requestModel(request.body))).toEqual(["routed", "routed"])
	} finally {
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop().catch(() => {})
	}
})

test("an explicit concrete CLI model overrides a resumed Auto session", async ({ terminal }) => {
	const exitMarker = "__KIMCHI_AUTO_OVERRIDE_FIRST_SESSION_EXITED__"
	const fixture = await createKimchiFixture({
		providerId: "kimchi-dev",
		initialModel: "auto",
		models: MODELS_WITH_OVERRIDE,
		routerResponses: [ROUTED_ROUTER_RESPONSE],
		responses: [{ stream: ["Initial routed reply."] }, { stream: ["Explicit override reply."] }],
	})

	try {
		launchKimchi(terminal, fixture, ["--enable-experimental-features"], fixture.seedEnv, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		terminal.submit("Resolve Auto before the resume")
		await waitForText(terminal, "Initial routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
		terminal.submit("/session")
		await waitForText(terminal, /ID:\s*[0-9a-f-]{36}/, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		const sessionId = fullText(terminal).match(/ID:\s*([0-9a-f-]{36})/)?.[1]
		expect(sessionId).toBeDefined()

		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		fixture.initialModel = false
		launchKimchi(
			terminal,
			fixture,
			["-r", sessionId ?? "", "--provider", "kimchi-dev", "--model", "override"],
			fixture.seedEnv,
		)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Use the explicit concrete model")
		await waitForText(terminal, "Explicit override reply.", { timeoutMs: STREAM_TIMEOUT_MS })
		await waitForTurnToSettle(fixture.fake.requests)

		expect(requestsTo(fixture, "/v1/route")).toHaveLength(1)
		const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
		expect(chatRequests.map((request) => requestModel(request.body))).toEqual(["routed", "override"])
		const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8"))
		expect(settings.defaultProvider).toBe("kimchi-dev")
		expect(settings.defaultModel).toBe("override")
	} finally {
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop().catch(() => {})
	}
})

test("a child that inherits Auto makes one independent routing decision", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-child-routes-independently",
			providerId: "kimchi-dev",
			initialModel: "auto",
			extraArgs: ["--enable-experimental-features"],
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE, ROUTED_ROUTER_RESPONSE],
			responses: [
				{ toolCalls: [agentCall("call_auto_child")] },
				{ stream: ["Parent finished."] },
				{ stream: ["Child route complete."], forSubagent: true },
			],
		},
		async (fixture) => {
			terminal.submit("Delegate this check")
			await waitForText(terminal, "Parent finished.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			const routerRequests = requestsTo(fixture, "/v1/route")
			expect(routerRequests).toHaveLength(2)
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests).toHaveLength(3)
			expect(chatRequests.map((request) => requestModel(request.body))).toEqual(["routed", "routed", "routed"])

			const parentRouterRequest = routerRequests.find((request) => !request.headers["x-parent-session-id"])
			const childRouterRequest = routerRequests.find((request) => request.headers["x-parent-session-id"])
			const childChatRequest = chatRequests.find((request) => request.headers["x-parent-session-id"])
			expect(childRouterRequest?.headers["x-session-id"]).toBe(parentRouterRequest?.headers["x-session-id"])
			expect(childRouterRequest?.headers["x-conversation-id"]).not.toBe(
				parentRouterRequest?.headers["x-conversation-id"],
			)
			expect(childRouterRequest?.headers["x-session-id"]).toBe(childChatRequest?.headers["x-session-id"])
			expect(childRouterRequest?.headers["x-conversation-id"]).toBe(childChatRequest?.headers["x-conversation-id"])
			expect(childRouterRequest?.headers["x-parent-session-id"]).toBe(childChatRequest?.headers["x-parent-session-id"])
		},
	)
})

test("a background child follows the same independent Auto routing path", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-background-child-routes-independently",
			providerId: "kimchi-dev",
			initialModel: "auto",
			extraArgs: ["--enable-experimental-features"],
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE, ROUTED_ROUTER_RESPONSE],
			responses: [
				{ toolCalls: [agentCall("call_auto_background_child", undefined, true)] },
				{ stream: ["Parent launched background child."] },
				{ stream: ["Background child route complete."], forSubagent: true },
			],
		},
		async (fixture) => {
			terminal.submit("Delegate this in the background")
			await waitForText(terminal, "Parent launched background child.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, /verify child routing[^\n]*completed/i, { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			expect(requestsTo(fixture, "/v1/route")).toHaveLength(2)
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests.length).toBeGreaterThanOrEqual(3)
			expect(chatRequests.every((request) => requestModel(request.body) === "routed")).toBe(true)
		},
	)
})

test("an explicitly selected concrete child model bypasses Auto routing", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-explicit-child-bypasses-router",
			providerId: "kimchi-dev",
			initialModel: "auto",
			extraArgs: ["--enable-experimental-features"],
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE],
			responses: [
				{ toolCalls: [agentCall("call_concrete_child", "kimchi-dev/routed")] },
				{ stream: ["Parent finished explicit child."] },
				{ stream: ["Child route complete."], forSubagent: true },
			],
		},
		async (fixture) => {
			terminal.submit("Delegate with the explicit model")
			await waitForText(terminal, "Parent finished explicit child.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			expect(requestsTo(fixture, "/v1/route")).toHaveLength(1)
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests).toHaveLength(3)
			expect(chatRequests.map((request) => requestModel(request.body))).toEqual(["routed", "routed", "routed"])
		},
	)
})
