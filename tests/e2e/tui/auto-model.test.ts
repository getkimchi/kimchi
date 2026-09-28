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
import type { FakeModel } from "./support/fake-openai-server.js"
import {
	createKimchiFixture,
	launchKimchi,
	PROMPT_READY,
	runKimchiSession,
	stopKimchi,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// The fake backend catalog: `auto` is an ordinary entry; routing happens
// server-side and the concrete pick comes back in the response `model` field
// (pi-ai surfaces it as `responseModel`).
const MODELS: FakeModel[] = [
	{
		slug: "routed",
		displayName: "Fake Routed",
		provider: "ai-enabler",
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
	// Listed after the concrete models — mirroring the backend catalog, where
	// virtual entries follow concrete ones (and upstream's no-default pick then
	// lands on a concrete model rather than Auto).
	{
		slug: "auto",
		displayName: "Auto",
		provider: "ai-enabler",
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
]

const MODELS_WITH_OVERRIDE: FakeModel[] = [
	...MODELS,
	{
		slug: "override",
		displayName: "Fake Override",
		provider: "ai-enabler",
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
]

function requestsTo<T extends { url: string }>(fixture: { fake: { requests: T[] } }, path: string): T[] {
	return fixture.fake.requests.filter((request) => request.url.startsWith(path))
}

function requestModel(body: unknown): string | undefined {
	return body && typeof body === "object" && "model" in body && typeof body.model === "string" ? body.model : undefined
}

function chatRequests(fixture: { fake: { requests: { url: string; body: unknown }[] } }) {
	return requestsTo(fixture, "/openai/v1/chat/completions")
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

test("/model autocomplete lists the backend-advertised Auto and selects it", async ({ terminal }) => {
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
			// Wait for the filter to apply: the concrete row drops out of the list.
			const filteredAt = Date.now()
			while (Date.now() - filteredAt < INPUT_TIMEOUT_MS) {
				if (!viewText(terminal).includes("routed [kimchi-dev]")) break
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
			// The backend descriptor's display name is the TUI row (the picker has no
			// description slot; ACP surfaces carry the description — see the ACP e2e).
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

test("backend-routed auto learns the pick, announces it, and resumes as auto", async ({ terminal }) => {
	const exitMarker = "__KIMCHI_AUTO_ROUTED_EXITED__"
	const fixture = await createKimchiFixture({
		providerId: "kimchi-dev",
		initialModel: "auto",
		models: MODELS,
		responses: [
			{ stream: ["First routed reply."], responseModel: "routed" },
			{ stream: ["Second routed reply."], responseModel: "routed" },
			{ stream: ["Resumed routed reply."], responseModel: "routed" },
		],
	})

	try {
		launchKimchi(terminal, fixture, [], fixture.seedEnv, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		terminal.submit("Choose a model for this session")
		await waitForText(terminal, "First routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
		await waitForText(terminal, "auto picked routed.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
		await waitForText(terminal, "auto → ctrl+p", { timeoutMs: STREAM_TIMEOUT_MS })

		terminal.submit("Keep using it")
		await waitForText(terminal, "Second routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
		await waitForTurnToSettle(fixture.fake.requests)

		terminal.submit("/session")
		await waitForText(terminal, /ID:\s*[0-9a-f-]{36}/, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		const sessionId = fullText(terminal).match(/ID:\s*([0-9a-f-]{36})/)?.[1]
		expect(sessionId).toBeDefined()
		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		// Resume restores the requested virtual model (auto), and the pick
		// notice survives in the transcript.
		launchKimchi(terminal, fixture, ["-r", sessionId ?? ""], fixture.seedEnv)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		await waitForText(terminal, "auto picked routed.", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Continue the same session")
		await waitForText(terminal, "Resumed routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
		await waitForTurnToSettle(fixture.fake.requests)

		// Honest attribution: every chat request asks for the virtual id, never
		// the concrete pick — and no client-side router exists to call.
		const chat = chatRequests(fixture)
		expect(chat.length).toBeGreaterThanOrEqual(3)
		expect(chat.every((request) => requestModel(request.body) === "auto")).toBe(true)
		expect(requestsTo(fixture, "/v1/route")).toHaveLength(0)
	} finally {
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop().catch(() => {})
	}
})

test("thinking controls follow the routed pick when it does not reason", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-non-reasoning-controls",
			providerId: "kimchi-dev",
			initialModel: "auto",
			models: MODELS,
			responses: [{ stream: ["Non-reasoning reply."], responseModel: "routed" }],
		},
		async (fixture) => {
			terminal.submit("Route to the plain model")
			await waitForText(terminal, "Non-reasoning reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "auto picked routed.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await waitForTurnToSettle(fixture.fake.requests)

			// Upstream 0.85.1 removed the global "Thinking level" /settings row in
			// favor of /thinking + per-model defaults, so drive the /thinking selector.
			terminal.write("/thinking")
			await waitForText(terminal, "/thinking", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "Thinking Level", { timeoutMs: INPUT_TIMEOUT_MS })

			const thinkingList = viewText(terminal)
			// The session synced to the non-reasoning pick exposes "off" only.
			expect(thinkingList).toMatch(/✓ +off +No reasoning/)
			expect(thinkingList).not.toMatch(
				/Very brief reasoning|Light reasoning|Moderate reasoning|Deep reasoning|Maximum reasoning/,
			)

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		},
	)
})

test("a new session installs the catalog's Auto as the default for an entitled account", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-new-session-default",
			providerId: "kimchi-dev",
			initialModel: false,
			models: MODELS,
			responses: [{ stream: ["Default Auto reply."], responseModel: "routed" }],
			seedHome: (homeDir) => {
				// A concrete default that the account never deliberately chose (login
				// and Ctrl+P both persist one), and the default not yet installed.
				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
				writeFileSync(
					settingsPath,
					JSON.stringify({ ...settings, defaultProvider: "kimchi-dev", defaultModel: "routed" }, null, "\t"),
				)
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, "Auto is now the default model.", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "auto → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("new session rolled into the catalog's Auto")
			terminal.submit("Route my first prompt")
			await waitForText(terminal, "Default Auto reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests).toHaveLength(1)
			expect(requestModel(chatRequests[0]?.body)).toBe("auto")
			trace.step("default Auto routed the first prompt server-side")
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
			expect(viewText(terminal)).not.toContain("Auto is now the default model.")
			trace.step("new session kept the model chosen after the switch")
			terminal.submit("Use my saved model")
			await waitForText(terminal, "Saved concrete default reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests).toHaveLength(1)
			expect(requestModel(chatRequests[0]?.body)).toBe("routed")
			trace.step("saved concrete default answered directly")
		},
	)
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
		const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
		expect(chatRequests).toHaveLength(1)
		expect(requestModel(chatRequests[0]?.body)).toBe("override")
	} finally {
		await stopKimchi(terminal)
		await fixture.stop()
	}
})

test("a saved Auto default keeps working across restarts", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-saved-default",
			providerId: "kimchi-dev",
			initialModel: false,
			models: MODELS,
			responses: [{ stream: ["Saved Auto still works."], responseModel: "routed" }],
			seedHome: (homeDir) => {
				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
				// The default is already installed — restoring it must not re-notify.
				writeFileSync(
					settingsPath,
					JSON.stringify(
						{ ...settings, defaultProvider: "kimchi-dev", defaultModel: "auto", autoDefaultApplied: true },
						null,
						"\t",
					),
				)
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, "auto → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain("Auto is now the default model.")
			trace.step("saved default restored without re-install")
			terminal.submit("Use my saved model")
			await waitForText(terminal, "Saved Auto still works.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests).toHaveLength(1)
			expect(requestModel(chatRequests[0]?.body)).toBe("auto")
			expect(viewText(terminal)).toContain("auto picked routed.")
		},
	)
})

test("an explicit concrete CLI model overrides a resumed Auto session", async ({ terminal }) => {
	const exitMarker = "__KIMCHI_AUTO_OVERRIDE_FIRST_SESSION_EXITED__"
	const fixture = await createKimchiFixture({
		providerId: "kimchi-dev",
		initialModel: "auto",
		models: MODELS_WITH_OVERRIDE,
		responses: [
			{ stream: ["Initial routed reply."], responseModel: "routed" },
			{ stream: ["Explicit override reply."] },
		],
	})

	try {
		launchKimchi(terminal, fixture, [], fixture.seedEnv, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		terminal.submit("Route before the resume")
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

		const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
		expect(chatRequests.map((request) => requestModel(request.body))).toEqual(["auto", "override"])
		const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8")) as {
			defaultProvider?: string
			defaultModel?: string
		}
		expect(settings.defaultProvider).toEqual("kimchi-dev")
		expect(settings.defaultModel).toEqual("override")
	} finally {
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop().catch(() => {})
	}
})

test("a child that inherits auto requests the same virtual id", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-model-child-routes-through-backend",
			providerId: "kimchi-dev",
			initialModel: "auto",
			models: MODELS,
			responses: [
				{ toolCalls: [agentCall("call_auto_child")] },
				{ stream: ["Parent finished."], responseModel: "routed" },
				{ stream: ["Child route complete."], responseModel: "routed", forSubagent: true },
			],
		},
		async (fixture) => {
			terminal.submit("Delegate this check")
			await waitForText(terminal, "Parent finished.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			// Both the parent and the independently-routed child ask for `auto`;
			// the backend serves each session's picks server-side. The child's reply
			// renders collapsed in the parent transcript, so assert on the wire.
			const chatRequests = requestsTo(fixture, "/openai/v1/chat/completions")
			expect(chatRequests.length).toBeGreaterThanOrEqual(3)
			expect(chatRequests.every((request) => requestModel(request.body) === "auto")).toBe(true)
		},
	)
})
