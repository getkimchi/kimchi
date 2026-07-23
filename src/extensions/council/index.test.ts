import type { Api, Model } from "@earendil-works/pi-ai"
import { AuthStorage, type ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import councilExtension, { sanitizeCouncilSessionRecord } from "./index.js"
import { CouncilTransactionRuntime } from "./transaction-runtime.js"
import type { CouncilRunRecord } from "./types.js"

type ProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1]

function register(): {
	appendEntry: ReturnType<typeof vi.fn>
	config: ProviderConfig
	getActiveTools: ReturnType<typeof vi.fn>
	on: ReturnType<typeof vi.fn>
	registerProvider: ReturnType<typeof vi.fn>
	registerTool: ReturnType<typeof vi.fn>
	setActiveTools: ReturnType<typeof vi.fn>
} {
	vi.stubEnv("KIMCHI_COUNCIL_ENABLED", "true")
	const on = vi.fn()
	const registerProvider = vi.fn()
	const appendEntry = vi.fn()
	const activeTools = new Set(["read", "edit", "write", "bash"])
	const registerTool = vi.fn((tool: { name: string }) => activeTools.add(tool.name))
	const getActiveTools = vi.fn(() => [...activeTools])
	const setActiveTools = vi.fn((names: string[]) => {
		activeTools.clear()
		for (const name of names) activeTools.add(name)
	})
	councilExtension({
		appendEntry,
		getActiveTools,
		on,
		registerProvider,
		registerTool,
		setActiveTools,
	} as unknown as ExtensionAPI)
	const [provider, config] = registerProvider.mock.calls[0]
	expect(provider).toBe("kimchi")
	return { appendEntry, config, getActiveTools, on, registerProvider, registerTool, setActiveTools }
}

const councilModel = {
	id: "council",
	name: "Kimchi Council",
	api: "kimchi-council",
	provider: "kimchi",
	baseUrl: "http://kimchi-council.invalid",
	reasoning: false,
	input: ["text"] as const,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 16_384,
} satisfies Model<Api>

const fastCouncilModel = {
	...councilModel,
	id: "council-fast",
	name: "Kimchi Council Fast",
	maxTokens: 8_192,
} satisfies Model<Api>

describe("councilExtension", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("registers fast, normal, and deep Council models as one inert virtual provider", () => {
		const { config } = register()

		expect(config).toMatchObject({
			api: "kimchi-council",
			baseUrl: "http://kimchi-council.invalid",
			apiKey: "unused-virtual-model-key",
			authHeader: false,
		})
		expect(config.models).toEqual([
			expect.objectContaining({ id: "council-fast", reasoning: false, maxTokens: 12_288 }),
			expect.objectContaining({ id: "council", reasoning: false, maxTokens: 24_576 }),
			expect.objectContaining({ id: "council-deep", reasoning: false, maxTokens: 32_768 }),
		])
		expect(config.streamSimple).toBeTypeOf("function")
	})

	it("exposes Council models through the real available-model registry by default", () => {
		vi.stubEnv("KIMCHI_COUNCIL_ENABLED", "")
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory())

		councilExtension({
			appendEntry: vi.fn(),
			on: vi.fn(),
			registerProvider: registry.registerProvider.bind(registry),
		} as unknown as ExtensionAPI)

		expect(
			registry
				.getAvailable()
				.filter((model) => model.api === "kimchi-council")
				.map((model) => `${model.provider}/${model.id}`),
		).toEqual(["kimchi/council-fast", "kimchi/council", "kimchi/council-deep"])
	})

	it("does not advertise more output than the configured lead", () => {
		vi.stubEnv("KIMCHI_COUNCIL_LEAD_MAX_TOKENS", "2048")
		const { config } = register()

		expect(config.models?.map(({ maxTokens }) => maxTokens)).toEqual([2048, 2048, 2048])
	})

	it("skips registration when Council is disabled", () => {
		vi.stubEnv("KIMCHI_COUNCIL_ENABLED", "false")
		const registerProvider = vi.fn()

		councilExtension({ on: vi.fn(), registerProvider } as unknown as ExtensionAPI)

		expect(registerProvider).not.toHaveBeenCalled()
	})

	it("uses the session registry and records the selected virtual model", async () => {
		const { appendEntry, config, on } = register()
		const find = vi.fn()
		const setStatus = vi.fn()
		const setWidget = vi.fn()
		const registry = { find, getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry
		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const sessionShutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		await sessionStart(
			{},
			{
				mode: "tui",
				modelRegistry: registry,
				sessionManager: { getSessionId: () => "session-a" },
				ui: { setStatus, setWidget },
			},
		)

		const result = await config.streamSimple?.(fastCouncilModel, { messages: [] }, { sessionId: "session-a" }).result()
		await sessionShutdown()

		expect(find).toHaveBeenCalledWith("kimchi-dev", "kimi-k2.7")
		expect(result?.errorMessage).toBe("Council could not complete the requested response")
		expect(appendEntry).toHaveBeenCalledWith(
			"council_run",
			expect.objectContaining({ outcome: "error", virtualModel: "kimchi/council-fast" }),
		)
		expect(setWidget).toHaveBeenNthCalledWith(1, "council-progress", expect.any(Function), {
			placement: "aboveEditor",
		})
		expect(setWidget).toHaveBeenNthCalledWith(2, "council-progress", undefined, { placement: "aboveEditor" })
		expect(setStatus.mock.calls[0]?.[1]).toContain("could not safely finalize · validation failed")
		expect(setStatus).toHaveBeenLastCalledWith("council", undefined)
	})

	it("removes physical model IDs from the persisted Council run without mutating the runtime record", () => {
		const record = {
			runId: "run",
			virtualModel: "kimchi/council",
			outcome: "error",
			unresolvedFindingCount: 0,
			missingReviewerRoles: [],
			durationMs: 1,
			stages: [
				{
					stage: "lead",
					modelRef: "physical/private-canary",
					status: "error",
					durationMs: 1,
					attempts: 1,
					error: "provider_error",
				},
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			budget: {
				logicalCalls: 1,
				physicalAttempts: 1,
				maxObservedConcurrency: 1,
				aggregateInputTokens: 0,
				aggregateOutputTokens: 0,
				estimatedCostUsd: 0,
				evidenceBytes: 0,
				structuredBytes: 0,
			},
			transaction: {
				transactionId: "transaction",
				state: "applied",
				outcome: "applied",
				patchSha256: "patch",
				stats: { files: 1, addedLines: 1, removedLines: 0, patchBytes: 10 },
				baseVerification: "passed",
				revisionCount: 0,
				postApplyChecks: [{ toolName: "bash", ok: true }],
				rollbackState: "not_available",
				hardRecoveryRequired: false,
			},
		} satisfies CouncilRunRecord
		Object.assign(record.transaction, { token: "server-secret", internalReasoning: "private chain" })

		const persisted = sanitizeCouncilSessionRecord(record)

		expect(record.stages[0]?.modelRef).toBe("physical/private-canary")
		expect(persisted.stages[0]).not.toHaveProperty("modelRef")
		expect(JSON.stringify(persisted)).not.toContain("private-canary")
		expect(persisted.transaction).toMatchObject({ transactionId: "transaction", patchSha256: "patch" })
		expect(JSON.stringify(persisted)).not.toMatch(/server-secret|private chain|token|internalReasoning/)
	})

	it("counts only allowlisted post-apply validation commands as checks", async () => {
		const state = vi.spyOn(CouncilTransactionRuntime.prototype, "state", "get").mockReturnValue("post_apply_checks")
		const recordCheck = vi.spyOn(CouncilTransactionRuntime.prototype, "recordPostApplyCheck")
		const { on } = register()
		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const toolStart = on.mock.calls.find(([event]) => event === "tool_execution_start")?.[1]
		const toolEnd = on.mock.calls.find(([event]) => event === "tool_execution_end")?.[1]
		const sessionShutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		const ctx = {
			cwd: process.cwd(),
			mode: "rpc",
			modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
			sessionManager: { getSessionId: () => "validation-session" },
		}
		await sessionStart({}, ctx)

		try {
			toolStart({ toolName: "bash", toolCallId: "read", args: { command: "git diff" } }, ctx)
			toolEnd({ toolName: "bash", toolCallId: "read", isError: false }, ctx)
			expect(recordCheck).not.toHaveBeenCalled()

			toolStart({ toolName: "bash", toolCallId: "test", args: { command: "pnpm test" } }, ctx)
			toolEnd({ toolName: "bash", toolCallId: "test", isError: false }, ctx)
			expect(recordCheck).toHaveBeenLastCalledWith("bash", "pnpm test", true)

			toolStart({ toolName: "bash", toolCallId: "failed", args: { command: "pnpm run typecheck" } }, ctx)
			toolEnd({ toolName: "bash", toolCallId: "failed", isError: true }, ctx)
			expect(recordCheck).toHaveBeenLastCalledWith("bash", "pnpm run typecheck", false)
			expect(recordCheck).toHaveBeenCalledTimes(2)
		} finally {
			await sessionShutdown({}, ctx)
			state.mockRestore()
			recordCheck.mockRestore()
		}
	})

	it("starts a fresh Council transaction on user input", async () => {
		const resetForNewTurn = vi.spyOn(CouncilTransactionRuntime.prototype, "resetForNewTurn")
		const { on } = register()
		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const input = on.mock.calls.find(([event]) => event === "input")?.[1]
		const sessionShutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		const ctx = {
			cwd: process.cwd(),
			mode: "rpc",
			modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
			sessionManager: { getSessionId: () => "new-turn-session" },
		}
		await sessionStart({}, ctx)

		try {
			await input({ source: "extension" }, ctx)
			expect(resetForNewTurn).not.toHaveBeenCalled()

			await input({ source: "interactive" }, ctx)
			expect(resetForNewTurn).toHaveBeenCalledOnce()
		} finally {
			await sessionShutdown({}, ctx)
			resetForNewTurn.mockRestore()
		}
	})

	it("abandons the previous transaction before replacing a session route", async () => {
		const abandon = vi.spyOn(CouncilTransactionRuntime.prototype, "abandon")
		const { on } = register()
		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const sessionShutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		const registry = { find: vi.fn(), getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry

		try {
			await sessionStart({}, { modelRegistry: registry, sessionManager: { getSessionId: () => "replaced-a" } })
			await sessionStart({}, { modelRegistry: registry, sessionManager: { getSessionId: () => "replaced-b" } })
			expect(abandon).toHaveBeenCalledTimes(1)
		} finally {
			await sessionShutdown()
			abandon.mockRestore()
		}
	})

	it.each([
		undefined,
		"sdk-generated-session-id",
	])("uses the only active route when the SDK supplies non-routable sessionId %s", async (sessionId) => {
		const { config, on } = register()
		const find = vi.fn()
		const registry = { find, getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry
		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const sessionShutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		await sessionStart({}, { modelRegistry: registry, sessionManager: { getSessionId: () => "compaction-session" } })

		try {
			await config.streamSimple?.(fastCouncilModel, { messages: [] }, { sessionId }).result()
			expect(find).toHaveBeenCalledWith("kimchi-dev", "kimi-k2.7")
		} finally {
			await sessionShutdown()
		}
	})

	it.each(["rpc", "json", "print"] as const)("does not call Council UI in %s mode", async (mode) => {
		const { config, on } = register()
		const setStatus = vi.fn()
		const setWidget = vi.fn()
		const registry = { find: vi.fn(), getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry
		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const sessionShutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		await sessionStart(
			{},
			{
				mode,
				modelRegistry: registry,
				sessionManager: { getSessionId: () => `non-tui-${mode}` },
				ui: { setStatus, setWidget },
			},
		)

		try {
			await config.streamSimple?.(fastCouncilModel, { messages: [] }, { sessionId: `non-tui-${mode}` }).result()
		} finally {
			await sessionShutdown()
		}

		expect(setStatus).not.toHaveBeenCalled()
		expect(setWidget).not.toHaveBeenCalled()
	})

	it("does not remount TUI progress when a queued run starts after session shutdown", async () => {
		const { config, on } = register()
		const setStatus = vi.fn()
		const setWidget = vi.fn()
		const registry = { find: vi.fn(), getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry
		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const sessionShutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		await sessionStart(
			{},
			{
				mode: "tui",
				modelRegistry: registry,
				sessionManager: { getSessionId: () => "shutdown-race" },
				ui: { setStatus, setWidget },
			},
		)

		const stream = config.streamSimple?.(fastCouncilModel, { messages: [] }, { sessionId: "shutdown-race" })
		await sessionShutdown()
		await stream?.result()

		expect(setStatus).not.toHaveBeenCalled()
		expect(setWidget).not.toHaveBeenCalled()
	})

	it("clears the ephemeral TUI summary on agent start and model selection", async () => {
		const { config, on } = register()
		const setStatus = vi.fn()
		const setWidget = vi.fn()
		const registry = { find: vi.fn(), getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry
		const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const agentStart = on.mock.calls.find(([event]) => event === "agent_start")?.[1]
		const modelSelect = on.mock.calls.find(([event]) => event === "model_select")?.[1]
		const sessionShutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		await sessionStart(
			{},
			{
				mode: "tui",
				modelRegistry: registry,
				sessionManager: { getSessionId: () => "lifecycle" },
				ui: { setStatus, setWidget },
			},
		)

		try {
			await config.streamSimple?.(fastCouncilModel, { messages: [] }, { sessionId: "lifecycle" }).result()
			expect(setStatus.mock.calls.at(-1)?.[1]).toContain("could not safely finalize")
			agentStart()
			expect(setStatus).toHaveBeenLastCalledWith("council", undefined)

			await config.streamSimple?.(fastCouncilModel, { messages: [] }, { sessionId: "lifecycle" }).result()
			expect(setStatus.mock.calls.at(-1)?.[1]).toContain("could not safely finalize")
			await modelSelect()
			expect(setStatus).toHaveBeenLastCalledWith("council", undefined)
		} finally {
			await sessionShutdown()
		}
	})

	it("routes concurrent sessions to their own registry and run record", async () => {
		const first = register()
		const second = register()
		const firstFind = vi.fn()
		const secondFind = vi.fn()
		const firstUI = { setStatus: vi.fn(), setWidget: vi.fn() }
		const secondUI = { setStatus: vi.fn(), setWidget: vi.fn() }
		const firstRegistry = { find: firstFind, getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry
		const secondRegistry = { find: secondFind, getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry
		const firstStart = first.on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const secondStart = second.on.mock.calls.find(([event]) => event === "session_start")?.[1]
		const firstShutdown = first.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		const secondShutdown = second.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1]
		await firstStart(
			{},
			{ mode: "tui", modelRegistry: firstRegistry, sessionManager: { getSessionId: () => "first" }, ui: firstUI },
		)
		await secondStart(
			{},
			{ mode: "tui", modelRegistry: secondRegistry, sessionManager: { getSessionId: () => "second" }, ui: secondUI },
		)

		try {
			const crossOwner = await first.config
				.streamSimple?.(councilModel, { messages: [] }, { sessionId: "second" })
				.result()
			expect(crossOwner?.errorMessage).toBe("Council model registry is unavailable")
			expect(firstFind).not.toHaveBeenCalled()
			expect(secondFind).not.toHaveBeenCalled()

			await first.config.streamSimple?.(councilModel, { messages: [] }, { sessionId: "first" }).result()

			expect(first.config.streamSimple).not.toBe(second.config.streamSimple)
			expect(firstFind).toHaveBeenCalledWith("kimchi-dev", "kimi-k2.7")
			expect(secondFind).not.toHaveBeenCalled()
			expect(first.appendEntry).toHaveBeenCalledWith(
				"council_run",
				expect.objectContaining({ virtualModel: "kimchi/council" }),
			)
			expect(second.appendEntry).not.toHaveBeenCalled()
			expect(firstUI.setWidget).toHaveBeenCalled()
			expect(firstUI.setStatus).toHaveBeenCalled()
			expect(secondUI.setWidget).not.toHaveBeenCalled()
			expect(secondUI.setStatus).not.toHaveBeenCalled()

			await firstShutdown()
			const firstWidgetCalls = firstUI.setWidget.mock.calls.length
			const firstStatusCalls = firstUI.setStatus.mock.calls.length
			await first.config.streamSimple?.(councilModel, { messages: [] }, { sessionId: "first" }).result()
			await second.config.streamSimple?.(councilModel, { messages: [] }, { sessionId: "second" }).result()

			expect(firstFind).toHaveBeenCalledTimes(1)
			expect(first.appendEntry).toHaveBeenCalledTimes(1)
			expect(secondFind).toHaveBeenCalledWith("kimchi-dev", "kimi-k2.7")
			expect(second.appendEntry).toHaveBeenCalledTimes(1)
			expect(firstUI.setWidget).toHaveBeenCalledTimes(firstWidgetCalls)
			expect(firstUI.setStatus).toHaveBeenCalledTimes(firstStatusCalls)
			expect(secondUI.setWidget).toHaveBeenCalled()
			expect(secondUI.setStatus).toHaveBeenCalled()
		} finally {
			await firstShutdown()
			await secondShutdown()
		}
	})
})
