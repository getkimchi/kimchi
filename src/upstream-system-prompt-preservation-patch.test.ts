import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { createModel } from "./extensions/__mocks__/model-registry.js"

const model = createModel("prompt-model", "prompt-provider")
const dirs: string[] = []

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("upstream custom-trigger prompt lifecycle", () => {
	it("injects extension messages and its forced prompt on successive custom turns after a tool change", async () => {
		const dir = mkdtempSync(join(tmpdir(), "upstream-custom-prompt-"))
		dirs.push(dir)
		const events: string[] = []
		const requests: Array<Array<{ role: string; content: string }>> = []
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "BASE PROMPT",
			appendSystemPromptOverride: () => [],
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("before_agent_start", (event) => {
						events.push(event.messageType)
						return {
							message: { customType: "from-extension", content: "injected context", display: false },
							systemPrompt: `FORCED ${event.messageType}`,
						}
					})
				},
			],
		})
		await loader.reload()
		const runtime = {
			getAuth: async () => ({ auth: { apiKey: "test" }, model }),
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ ok: true }),
			getModel: () => model,
			streamSimple: (_model: unknown, context: { messages: Array<{ role: string; content: unknown }> }) => {
				requests.push(
					context.messages.map((message) => ({ role: message.role, content: JSON.stringify(message.content) })),
				)
				const assistant = {
					role: "assistant" as const,
					provider: model.provider,
					model: model.id,
					api: model.api,
					timestamp: Date.now(),
					stopReason: "stop" as const,
					content: [],
				}
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "done" as const, message: assistant }
					},
					result: async () => assistant,
				}
			},
		} as unknown as ModelRuntime
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			sessionManager: SessionManager.inMemory(dir),
			settingsManager: SettingsManager.create(dir, dir),
			model,
			modelRuntime: runtime,
			resourceLoader: loader,
			tools: [],
		})
		await session.bindExtensions({
			onError: (error) => {
				throw new Error(error.error)
			},
		})
		try {
			for (let turn = 0; turn < 2; turn++) {
				await session.sendCustomMessage(
					{ customType: `trigger-${turn}`, content: `custom-${turn}`, display: false },
					{ triggerTurn: true },
				)
				session.setActiveToolsByName([])
			}
		} finally {
			session.dispose()
		}

		expect(events).toEqual(["custom", "custom"])
		expect(requests).toHaveLength(2)
		for (const [turn, messages] of requests.entries()) {
			expect(messages[0]).toEqual({ role: "system", content: '"FORCED custom"' })
			const triggerIndex = messages.findIndex((message) => message.content.includes(`custom-${turn}`))
			expect(triggerIndex).toBeGreaterThanOrEqual(0)
			expect(messages.slice(triggerIndex).map((message) => message.content)).toEqual(
				[`custom-${turn}`, "injected context"].map((text) => JSON.stringify([{ type: "text", text }])),
			)
		}
		expect(session.agent.state.systemPrompt).not.toContain("FORCED custom")
	})
})

type AnyFn = (...args: unknown[]) => unknown
const sessionProto = AgentSession.prototype as unknown as Record<string, AnyFn>

describe("upstream forced-prompt projection", () => {
	it("replaces all leading system messages without losing other context", async () => {
		const session: Record<string, unknown> = {
			agent: { transformContext: undefined },
			_runSystemPromptOptions: { forceSystemPrompt: "KIMCHI FORCED PROMPT" },
		}
		sessionProto._installAgentForcedPromptProjection.call(session)
		const transform = (
			session.agent as { transformContext: (messages: unknown[], signal?: AbortSignal) => Promise<unknown[]> }
		).transformContext
		const output = (await transform([
			{ role: "system", content: "PI BASE PROMPT", timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
			{ role: "system", content: "LATER BASE PROMPT", timestamp: 3 },
		])) as Array<{ role: string; content: string }>
		expect(output).toEqual([
			{ role: "system", content: "KIMCHI FORCED PROMPT", timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		])
	})

	it("passes context through unchanged when no prompt is forced", async () => {
		const session: Record<string, unknown> = { agent: { transformContext: undefined } }
		sessionProto._installAgentForcedPromptProjection.call(session)
		const transform = (
			session.agent as { transformContext: (messages: unknown[], signal?: AbortSignal) => Promise<unknown[]> }
		).transformContext
		const input = [{ role: "system", content: "PI BASE PROMPT", timestamp: 1 }]
		expect(await transform(input)).toEqual(input)
	})
})
