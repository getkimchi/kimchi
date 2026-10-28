// subagent-resource-loader.test.ts
//
// Real-SDK regression tests for the subagent single-load contract
// (subagent-double-extension-load investigation):
//
// agent-runner constructs subagent sessions with a DefaultResourceLoader and
// used to call `loader.reload()` a SECOND time after binding — solely to
// re-evaluate `systemPromptOverride` for the final active-tool list. Each
// reload re-runs every inline extension factory against the loader's shared
// event bus, so the orphaned copy kept its bus subscriptions and every channel
// event reached two subscribers (2× telemetry records).
//
// SubagentResourceLoader fixes this by reading the prompt live via
// `readSystemPrompt`, making the second reload unnecessary. These tests use
// the REAL pi SDK (createAgentSession + SubagentResourceLoader, no module
// mocks) and assert:
//   1. the factory runs exactly ONCE through the full lifecycle (initial
//      reload, session creation, binding, prompt reassignment, tool
//      activation), and
//   2. one announced bus event reaches exactly ONE subscriber, and
//   3. the session's system prompt picks up the reassigned prompt value
//      (what setActiveToolsByName rebuilds for the next model request).
//
// Both agent-runner tool branches are mirrored: extensions enabled (no
// `tools` allowlist) and extensions disabled (`noExtensions: true` +
// `tools` allowlist).

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
	createAgentSession,
	createEventBus,
	defineTool,
	type ExtensionAPI,
	type InlineExtension,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { afterAll, describe, expect, it } from "vitest"
import { SubagentResourceLoader } from "./subagent-resource-loader.js"

/** Minimal model stub — the session never streams in these tests, so the
 *  model and runtime only need to satisfy construction-time shape checks. */
const fakeModel = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "test",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as unknown as Model<Api>

const TEST_CHANNEL = "kimchi-test:single-load"

const tmpDirs: string[] = []

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "subagent-loader-"))
	tmpDirs.push(dir)
	return dir
}

afterAll(() => {
	for (const dir of tmpDirs) {
		rmSync(dir, { recursive: true, force: true })
	}
})

/** A counting extension factory that subscribes to the test channel. */
function countingExtension(count: { runs: number; deliveries: unknown[] }): InlineExtension {
	return (pi: ExtensionAPI) => {
		count.runs++
		pi.events.on(TEST_CHANNEL, (payload) => count.deliveries.push(payload))
	}
}

/** Mirrors agent-runner's post-binding sequence: reassign the prompt (the
 *  final active-tool list is only known after binding), then activate tools —
 *  with NO second loader.reload() (that is the regression under test). */
async function runLifecycle(opts: { noExtensions: boolean; toolNames?: string[] }) {
	const tmp = makeTmpDir()
	const count = { runs: 0, deliveries: [] as unknown[] }
	const bus = createEventBus()
	let systemPrompt = "initial-prompt-PRE-BINDING"

	const loader = new SubagentResourceLoader({
		cwd: tmp,
		agentDir: tmp,
		noExtensions: opts.noExtensions,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		eventBus: bus,
		readSystemPrompt: () => systemPrompt,
		appendSystemPromptOverride: () => [],
		extensionFactories: [countingExtension(count)],
	})

	// Load #1 — the only one.
	await loader.reload()
	const runsAfterReload = count.runs

	const { session } = await createAgentSession({
		cwd: tmp,
		agentDir: tmp,
		sessionManager: SessionManager.inMemory(tmp),
		settingsManager: SettingsManager.create(tmp, tmp),
		model: fakeModel,
		modelRuntime: {} as ModelRuntime,
		resourceLoader: loader,
		...(opts.toolNames ? { tools: opts.toolNames } : {}),
	})
	await session.bindExtensions({
		onError: (err) => {
			throw new Error(`extension failed in child session: ${err.error ?? err.extensionPath}`)
		},
	})
	const runsAfterBind = count.runs

	// The final prompt is resolved here — after binding, like agent-runner's
	// buildSystemPrompt(activeTools). The live getter must pick it up.
	systemPrompt = "final-prompt-POST-BINDING"
	session.setActiveToolsByName(session.getActiveToolNames())

	// Cleanup mirrors agent-runner: emit session_shutdown then dispose.
	await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
	session.dispose()

	return {
		runsAfterReload,
		runsAfterBind,
		runsAfterActivation: count.runs,
		deliveries: count.deliveries,
		loader,
		sessionPrompt: session.systemPrompt,
		activeToolNames: session.getActiveToolNames(),
	}
}

describe("SubagentResourceLoader — single-load contract", () => {
	it("runs each extension factory once through the full lifecycle (extensions enabled)", async () => {
		const result = await runLifecycle({ noExtensions: false })

		expect(result.runsAfterReload, "factory runs after initial reload").toBe(1)
		expect(result.runsAfterBind, "factory runs after session creation + binding").toBe(1)
		expect(result.runsAfterActivation, "factory runs after prompt update + tool activation").toBe(1)

		// The pre-binding prompt snapshot never leaks into the final session
		// prompt: the model sees the post-binding value.
		expect(result.sessionPrompt).toContain("final-prompt-POST-BINDING")
		expect(result.sessionPrompt).not.toContain("initial-prompt-PRE-BINDING")
		expect(result.loader.getSystemPrompt()).toBe("final-prompt-POST-BINDING")
	})

	it("runs each extension factory once through the full lifecycle (extensions disabled)", async () => {
		const result = await runLifecycle({ noExtensions: true, toolNames: ["read", "grep"] })

		expect(result.runsAfterReload).toBe(1)
		expect(result.runsAfterBind).toBe(1)
		expect(result.runsAfterActivation).toBe(1)

		expect(result.activeToolNames).toContain("read")
		expect(result.sessionPrompt).toContain("final-prompt-POST-BINDING")
	})

	it("delivers one announced bus event to exactly one subscriber", async () => {
		const tmp = makeTmpDir()
		const count = { runs: 0, deliveries: [] as unknown[] }
		const bus = createEventBus()
		let systemPrompt = "initial"

		const loader = new SubagentResourceLoader({
			cwd: tmp,
			agentDir: tmp,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			eventBus: bus,
			readSystemPrompt: () => systemPrompt,
			appendSystemPromptOverride: () => [],
			extensionFactories: [countingExtension(count)],
		})
		await loader.reload()

		const { session } = await createAgentSession({
			cwd: tmp,
			agentDir: tmp,
			sessionManager: SessionManager.inMemory(tmp),
			settingsManager: SettingsManager.create(tmp, tmp),
			model: fakeModel,
			modelRuntime: {} as ModelRuntime,
			resourceLoader: loader,
			tools: ["read"],
		})
		await session.bindExtensions({
			onError: (err) => {
				throw new Error(`extension failed in child session: ${err.error ?? err.extensionPath}`)
			},
		})

		systemPrompt = "final"
		session.setActiveToolsByName(session.getActiveToolNames())

		// One announced channel event must reach exactly one subscriber. The
		// old double-reload left an orphaned copy subscribed to the same bus,
		// so this delivered twice.
		bus.emit(TEST_CHANNEL, { marker: "only-once" })
		expect(count.deliveries).toEqual([{ marker: "only-once" }])

		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
		session.dispose()
	})

	it("keeps an extension-registered tool callable through the no-reload activation path", async () => {
		const tmp = makeTmpDir()
		const bus = createEventBus()
		let systemPrompt = "initial"

		const extension: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerTool(
				defineTool({
					name: "test_extension_tool",
					label: "Test Extension Tool",
					description: "Extension-registered tool (worker-report shape).",
					parameters: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					} as const,
					execute: async (_toolCallId, params) =>
						({ output: `received ${(params as { value: string }).value}` }) as never,
				}),
			)
		}

		const loader = new SubagentResourceLoader({
			cwd: tmp,
			agentDir: tmp,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			eventBus: bus,
			readSystemPrompt: () => systemPrompt,
			appendSystemPromptOverride: () => [],
			extensionFactories: [extension],
		})
		await loader.reload()

		const { session } = await createAgentSession({
			cwd: tmp,
			agentDir: tmp,
			sessionManager: SessionManager.inMemory(tmp),
			settingsManager: SettingsManager.create(tmp, tmp),
			model: fakeModel,
			modelRuntime: {} as ModelRuntime,
			resourceLoader: loader,
			tools: ["read", "test_extension_tool"],
		})
		await session.bindExtensions({
			onError: (err) => {
				throw new Error(`extension failed in child session: ${err.error ?? err.extensionPath}`)
			},
		})

		// Mirrors the worker-report re-add: the extension tool stays active
		// when the final tool list is applied without reloading the loader.
		expect(session.getToolDefinition("test_extension_tool")).toBeDefined()
		const active = new Set(session.getActiveToolNames())
		expect(active.has("read")).toBe(true)
		expect(active.has("test_extension_tool")).toBe(true)

		systemPrompt = "final"
		session.setActiveToolsByName([...active])
		expect(new Set(session.getActiveToolNames()).has("test_extension_tool")).toBe(true)
		expect(session.systemPrompt).toContain("final")

		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
		session.dispose()
	})
})
