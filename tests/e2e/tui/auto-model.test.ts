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

test("/model autocomplete shows and selects Auto for an entitled account without experimental features", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-autocomplete-selection",
			providerId: "kimchi-dev",
			initialModel: "routed",
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
			// Upstream 0.85.1 added a "✓ current model" marker column: the row renders
			// as "→   auto [kimchi-dev]" (cursor, marker column, then the label).
			expect(viewText(terminal)).toMatch(/→\s+auto \[kimchi-dev\]/)
			trace.step("Auto highlighted")

			terminal.submit("")
			await waitForText(terminal, "Default model: kimchi-dev/auto", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
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
			// traceparent is per provider-request header assembly: the router
			// call inherits the correlation headers of the chat request it
			// routes (same trace), while the second chat request is a separate
			// assembly and therefore a fresh trace.
			const traceparentShape = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/
			expect(routerRequests[0]?.headers.traceparent).toMatch(traceparentShape)
			expect(chatRequests[0]?.headers.traceparent).toMatch(traceparentShape)
			expect(chatRequests[1]?.headers.traceparent).toMatch(traceparentShape)
			expect(routerRequests[0]?.headers.traceparent).toBe(chatRequests[0]?.headers.traceparent)
			expect(chatRequests[1]?.headers.traceparent).not.toBe(chatRequests[0]?.headers.traceparent)
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
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE],
			responses: [{ stream: ["Non-reasoning reply."] }],
		},
		async (fixture) => {
			terminal.submit("Route to the plain model")
			await waitForText(terminal, "Non-reasoning reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			// Upstream 0.85.1 removed the global "Thinking level" /settings row in
			// favor of /thinking + per-model defaults, so drive the /thinking selector.
			terminal.write("/thinking")
			await waitForText(terminal, "/thinking", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "Thinking Level", { timeoutMs: INPUT_TIMEOUT_MS })

			const thinkingList = viewText(terminal)
			// The Auto model synced to a non-reasoning routed model exposes "off" only.
			expect(thinkingList).toMatch(/✓ +off +No reasoning/)
			expect(thinkingList).not.toMatch(
				/Very brief reasoning|Light reasoning|Moderate reasoning|Deep reasoning|Maximum reasoning/,
			)

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
			extraArgs: ["--models", "kimchi-dev/fallback"],
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

test("a new session defaults to Auto without experimental features", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-new-session-default",
			providerId: "kimchi-dev",
			initialModel: false,
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE],
			responses: [{ stream: ["Default Auto reply."] }],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "auto → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("new session selected Auto")
			terminal.submit("Route my first prompt")
			await waitForText(terminal, "Default Auto reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			expect(requestsTo(fixture, "/v1/route")).toHaveLength(1)
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests).toHaveLength(1)
			expect(requestModel(chatRequests[0]?.body)).toBe("routed")
			trace.step("default Auto routed the first prompt")
		},
	)
})

test("an already-applied default leaves a switched-away install on its own model", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-default-already-applied",
			providerId: "kimchi-dev",
			initialModel: false,
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE],
			responses: [{ stream: ["Saved concrete default reply."] }],
			seedHome: (homeDir) => {
				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
				writeFileSync(
					settingsPath,
					JSON.stringify(
						{
							...settings,
							defaultProvider: "kimchi-dev",
							defaultModel: "routed",
							enabledModels: ["kimchi-dev/auto", "kimchi-dev/routed"],
							// Auto was already installed as the default here, so the
							// concrete model is a deliberate switch away from it and
							// must survive restarts.
							autoDefaultApplied: true,
						},
						null,
						"\t",
					),
				)
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, "routed → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("new session kept the model chosen after the switch")
			terminal.submit("Use my saved model")
			await waitForText(terminal, "Saved concrete default reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			// Already rolled in and switched away: no re-roll, so no routing.
			expect(requestsTo(fixture, "/v1/route")).toHaveLength(0)
			expect(requestModel(requestsTo(fixture, "/openai/v1/chat/completions")[0]?.body)).toBe("routed")
			trace.step("saved concrete default answered directly")
		},
	)
})

test("an entitled account gets Auto as the default and is told once", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-default-applies",
			providerId: "kimchi-dev",
			initialModel: false,
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE],
			responses: [{ stream: ["Rolled into Auto."] }],
			seedHome: (homeDir) => {
				// A concrete default that the account never deliberately chose (login
				// and Ctrl+P both persist one), and the default not yet installed.
				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
				writeFileSync(
					settingsPath,
					JSON.stringify(
						{
							...settings,
							defaultProvider: "kimchi-dev",
							defaultModel: "routed",
							enabledModels: ["kimchi-dev/auto", "kimchi-dev/routed"],
						},
						null,
						"\t",
					),
				)
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, "auto → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "Auto is now the default model.", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("the session switched to Auto and said so")
			terminal.submit("Route this one")
			await waitForText(terminal, "Rolled into Auto.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			expect(requestsTo(fixture, "/v1/route")).toHaveLength(1)
			trace.step("the session routes through Auto")
		},
	)
})

test("Auto stays hidden from the model picker for accounts without the flag or entitlement", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-picker-hidden-external",
			providerId: "kimchi-dev",
			initialModel: "routed",
			models: MODELS,
			responses: [],
			userEmail: "someone@example.com",
		},
		async (_fixture, trace) => {
			terminal.write("/model")
			await waitForText(terminal, "/model", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "Only showing models from configured providers", {
				timeoutMs: INPUT_TIMEOUT_MS,
				full: false,
			})
			trace.step("model picker open")

			terminal.write("auto")
			await waitForText(terminal, "auto", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			const picker = viewText(terminal)
			expect(picker).not.toContain("Auto (Kimchi Router)")
			expect(picker).not.toContain("auto [kimchi-dev]")
			trace.step("Auto row absent for a non-entitled account")
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		},
	)
})

test("--model auto without the flag fails fast for accounts without the entitlement", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		providerId: "kimchi-dev",
		initialModel: false,
		models: MODELS,
		responses: [],
		userEmail: "someone@example.com",
	})

	try {
		// No exitMarker: its `printf '\033c'` is a terminal full-reset that would
		// wipe the refusal off screen before it can be asserted. The refusal text
		// itself is the signal that the launch was rejected pre-main.
		launchKimchi(terminal, fixture, ["--model", "auto"], fixture.seedEnv)
		await waitForText(terminal, "kimchi-dev/auto is experimental", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
	} finally {
		await stopKimchi(terminal)
		await fixture.stop()
	}
})

test("Ctrl+P cycles through concrete models and wraps back to Auto", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-cycle-wrap",
			providerId: "kimchi-dev",
			initialModel: false,
			models: MODELS,
			responses: [],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "auto → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.keyPress("p", { ctrl: true })
			await waitForText(terminal, "routed → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("cycled to concrete model")
			terminal.keyPress("p", { ctrl: true })
			await waitForText(terminal, "auto → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("wrapped to Auto")
		},
	)
})

test("a session-scoped /model choice survives resume but not /new or restart", async ({ terminal }) => {
	const exitMarker = "__KIMCHI_AUTO_LIFECYCLE_EXITED__"
	const fixture = await createKimchiFixture({
		providerId: "kimchi-dev",
		initialModel: false,
		models: MODELS_WITH_OVERRIDE,
		responses: [{ stream: ["Concrete session reply."] }],
	})

	try {
		// First launch installs Auto as the default, so the session starts on Auto.
		launchKimchi(terminal, fixture, [], fixture.seedEnv, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		await waitForText(terminal, "auto → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		terminal.submit("/model kimchi-dev/override")
		await waitForText(terminal, "Model: override", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		terminal.submit("Use my concrete model")
		await waitForText(terminal, "Concrete session reply.", { timeoutMs: STREAM_TIMEOUT_MS })
		await waitForTurnToSettle(fixture.fake.requests)
		terminal.submit("/session")
		await waitForText(terminal, /ID:\s*[0-9a-f-]{36}/, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		const sessionId = fullText(terminal).match(/ID:\s*([0-9a-f-]{36})/)?.[1]
		expect(sessionId).toBeDefined()
		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		// `/model <id>` is session-scoped upstream (persist: false), so it leaves
		// the saved default alone: the restart comes back on the rolled-in Auto.
		// The default is already installed — Auto is restored from it rather than
		// applied a second time, so the notice does not appear again.
		launchKimchi(terminal, fixture, [], fixture.seedEnv, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		await waitForText(terminal, "auto → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		expect(viewText(terminal)).not.toContain("Auto is now the default model.")
		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		// The session-scoped choice still survives resuming that session.
		launchKimchi(terminal, fixture, ["-r", sessionId ?? ""], fixture.seedEnv)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		await waitForText(terminal, "override → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		terminal.submit("/new")
		await waitForText(terminal, "auto → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		expect(requestsTo(fixture, "/v1/route")).toHaveLength(0)
		expect(requestModel(requestsTo(fixture, "/openai/v1/chat/completions")[0]?.body)).toBe("override")
	} finally {
		await stopKimchi(terminal)
		await fixture.stop()
	}
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
		launchKimchi(terminal, fixture, [], fixture.seedEnv, { exitMarker })
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
		launchKimchi(terminal, fixture, [], fixture.seedEnv, { exitMarker })
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
