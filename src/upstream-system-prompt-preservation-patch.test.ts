/**
 * Regression tests for Pi's native `setActiveToolsByName()` override
 * preservation and Kimchi's resource-reload patch.
 *
 * Why: kimchi's prompt-enrichment extension replaces the system prompt on
 * every `before_agent_start`. Mid-run `pi.setActiveTools()` calls (ferment
 * tool profiles, permissions, tool visibility) used to reset
 * `agent.state.systemPrompt` to the rebuilt pi-mono default prompt, and — via
 * the prepareNextTurn patch — the model then ran on the default prompt for
 * the rest of the agent run (until the next real user prompt). Follow-up
 * messages never re-fire `before_agent_start`, so the clobber persisted.
 *
 * These tests pin two things:
 *   1. the installed dist actually contains the patch (source assertion —
 *      fails fast if the patch is lost on upgrade), and
 *   2. the real prototype method preserves a non-base prompt while still
 *      rebuilding the base prompt and the tool set.
 */

import { AgentSession } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

type AnyFn = (...args: unknown[]) => unknown

const sessionProto = AgentSession.prototype as unknown as Record<string, AnyFn>

/** Minimal fake `this` for calling AgentSession prototype methods directly. */
function makeFakeSession(basePrompt: string) {
	const tools = new Map([
		["read", { name: "read", description: "read a file", parameters: {} }],
		["bash", { name: "bash", description: "run a command", parameters: {} }],
	])
	// Inherit from the real prototype so every collaborator method invoked
	// internally (_rebuildSystemPrompt, getActiveToolNames, …) resolves.
	// biome-ignore lint/suspicious/noExplicitAny: fake `this` for prototype-method invocation
	const fake: any = Object.create(AgentSession.prototype)
	Object.assign(fake, {
		agent: { state: { tools: [], systemPrompt: basePrompt } },
		_baseSystemPrompt: basePrompt,
		_toolRegistry: tools,
		_toolPromptSnippets: new Map(),
		_toolPromptGuidelines: new Map(),
		_cwd: "/tmp/fake-cwd",
		_resourceLoader: {
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			getSkills: () => ({ skills: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			extendResources: vi.fn(),
		},
		_extensionRunner: {
			hasHandlers: () => true,
			emitResourcesDiscover: vi.fn(async () => ({
				skillPaths: [{ path: "/tmp/fake-skills", extensionPath: "/tmp/fake-ext" }],
				promptPaths: [],
				themePaths: [],
			})),
		},
		// Instance stubs so extendResourcesFromExtensions doesn't reach further
		// into prototype internals (getExtensionSourceLabel etc.).
		buildExtensionResourcePaths: vi.fn(() => []),
	})
	return fake
}

describe("upstream system-prompt preservation patch", () => {
	it("is present in the installed dist (setActiveToolsByName + resource reload)", () => {
		const setActiveSource = String(sessionProto.setActiveToolsByName)
		expect(setActiveSource).toContain("_systemPromptOverride")

		const reloadSource = String(sessionProto.extendResourcesFromExtensions)
		expect(reloadSource).toContain("kimchi-dev: preserve a before_agent_start prompt")
	})

	it("setActiveToolsByName preserves an extension-installed prompt while rebuilding tools and base", () => {
		const fake = makeFakeSession("PI BASE PROMPT")
		fake.agent.state.systemPrompt = "KIMCHI OVERRIDE PROMPT"
		fake._systemPromptOverride = "KIMCHI OVERRIDE PROMPT"

		sessionProto.setActiveToolsByName.call(fake, ["read", "bash"])

		expect(fake.agent.state.systemPrompt).toBe("KIMCHI OVERRIDE PROMPT")
		// Tool set is still replaced:
		expect(fake.agent.state.tools.map((t: { name: string }) => t.name)).toEqual(["read", "bash"])
		// Base prompt is still rebuilt from the new tool set (no longer the old base):
		expect(fake._baseSystemPrompt).not.toBe("PI BASE PROMPT")
	})

	it("setActiveToolsByName resets to the rebuilt base prompt when no override is active", () => {
		const fake = makeFakeSession("PI BASE PROMPT")
		// state.systemPrompt === _baseSystemPrompt (same reference): no extension override.
		sessionProto.setActiveToolsByName.call(fake, ["read"])

		expect(fake.agent.state.systemPrompt).toBe(fake._baseSystemPrompt)
		expect(fake.agent.state.systemPrompt).not.toBe("PI BASE PROMPT")
	})

	it("setActiveToolsByName preserves the override even when the tool set is emptied", () => {
		const fake = makeFakeSession("PI BASE PROMPT")
		fake.agent.state.systemPrompt = "KIMCHI OVERRIDE PROMPT"
		fake._systemPromptOverride = "KIMCHI OVERRIDE PROMPT"

		// ferment plan-review suppression calls pi.setActiveTools([]).
		sessionProto.setActiveToolsByName.call(fake, [])

		expect(fake.agent.state.systemPrompt).toBe("KIMCHI OVERRIDE PROMPT")
		expect(fake.agent.state.tools).toEqual([])
	})

	it("extendResourcesFromExtensions preserves an extension-installed prompt", async () => {
		const fake = makeFakeSession("PI BASE PROMPT")
		fake.agent.state.systemPrompt = "KIMCHI OVERRIDE PROMPT"
		fake._systemPromptOverride = "KIMCHI OVERRIDE PROMPT"

		await sessionProto.extendResourcesFromExtensions.call(fake, "startup")

		expect(fake.agent.state.systemPrompt).toBe("KIMCHI OVERRIDE PROMPT")
		expect(fake._baseSystemPrompt).not.toBe("PI BASE PROMPT")
	})

	it("extendResourcesFromExtensions resets to the rebuilt base prompt when no override is active", async () => {
		const fake = makeFakeSession("PI BASE PROMPT")
		// state.systemPrompt === _baseSystemPrompt (same reference): no extension override.
		await sessionProto.extendResourcesFromExtensions.call(fake, "startup")

		expect(fake.agent.state.systemPrompt).toBe(fake._baseSystemPrompt)
		expect(fake.agent.state.systemPrompt).not.toBe("PI BASE PROMPT")
	})
})

describe("upstream before_agent_start on extension-triggered turns patch", () => {
	function makeTriggerTurnSession(beforeResult: unknown) {
		const fake = makeFakeSession("PI BASE PROMPT")
		fake._runAgentPrompt = vi.fn(async () => {})
		fake._extensionRunner = {
			emitBeforeAgentStart: vi.fn(async () => beforeResult),
		}
		return fake
	}

	const customMessage = {
		customType: "ferment_continuation_nudge",
		content: [{ type: "text", text: "continue the ferment" }],
		display: false,
		details: undefined,
	}

	it("is present in the installed dist (sendCustomMessage triggerTurn)", () => {
		const source = String(sessionProto.sendCustomMessage)
		expect(source).toContain("emitBeforeAgentStart")
	})

	it("triggerTurn applies an extension-installed prompt and prepends extension messages", async () => {
		const fake = makeTriggerTurnSession({
			systemPrompt: "KIMCHI OVERRIDE PROMPT",
			messages: [{ customType: "injected", content: [{ type: "text", text: "ctx" }], display: false }],
		})

		await sessionProto.sendCustomMessage.call(fake, customMessage, { triggerTurn: true })

		expect(fake.agent.state.systemPrompt).toBe("KIMCHI OVERRIDE PROMPT")
		const runMessages = fake._runAgentPrompt.mock.calls[0][0] as Array<{ role: string; customType: string }>
		expect(runMessages.map((m) => m.customType)).toEqual(["injected", "ferment_continuation_nudge"])
	})

	it("triggerTurn resets to the base prompt when no extension overrides it", async () => {
		const fake = makeTriggerTurnSession(undefined)
		fake.agent.state.systemPrompt = "STALE OVERRIDE"

		await sessionProto.sendCustomMessage.call(fake, customMessage, { triggerTurn: true })

		expect(fake.agent.state.systemPrompt).toBe("PI BASE PROMPT")
	})

	it("triggerTurn accepts plain-string content (completion notifications, feedback nudges)", async () => {
		const fake = makeTriggerTurnSession({ systemPrompt: "KIMCHI OVERRIDE PROMPT" })

		await sessionProto.sendCustomMessage.call(
			fake,
			{ customType: "agent_completion", content: "long task completed", display: true },
			{ triggerTurn: true },
		)

		expect(fake.agent.state.systemPrompt).toBe("KIMCHI OVERRIDE PROMPT")
		expect(fake._extensionRunner.emitBeforeAgentStart).toHaveBeenCalledWith(
			"long task completed",
			undefined,
			"PI BASE PROMPT",
			undefined,
		)
		expect(fake._runAgentPrompt).toHaveBeenCalledOnce()
	})
})
