import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import modelGuard, {
	__resetImagesDetectedForTest,
	getLatestMessages,
	hasImages,
	sessionHasImages,
} from "./model-guard.js"
import modelSwitch from "./model-switch.js"
import stripImages from "./strip-images.js"
import { flushWorkSummaries } from "./work-attribution/summary.js"

const { completeMock } = vi.hoisted(() => ({ completeMock: vi.fn() }))
vi.mock("@earendil-works/pi-ai/compat", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/compat")>("@earendil-works/pi-ai/compat")
	return { ...actual, complete: (...args: unknown[]) => completeMock(...args) }
})

function harness(images: SessionEntry[], tokens = 150_000) {
	__resetImagesDetectedForTest()
	type Handler = (event: unknown, ctx: unknown) => unknown
	const handlers = new Map<string, Set<Handler>>()
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>()
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>()
	const setModel = vi.fn(async (_model: { id: string }) => true)
	const pi = {
		on(event: string, handler: Handler) {
			if (!handlers.has(event)) handlers.set(event, new Set())
			handlers.get(event)?.add(handler)
		},
		registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
			tools.set(tool.name, tool)
		},
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			commands.set(name, command)
		},
		setModel,
	}
	const trigger = async <T = unknown>(event: string, data: unknown, ctx: unknown): Promise<T | undefined> => {
		let result: T | undefined
		for (const handler of handlers.get(event) ?? []) result = (await handler(data, ctx)) as T
		return result
	}
	modelGuard(pi as never)
	modelSwitch(pi as never)
	stripImages(pi as never)

	const ctx = createContext({
		model: { id: "vision", provider: "fake", input: ["text", "image"] },
		modelRegistry: {
			getAvailable: () => [
				{ id: "vision", provider: "fake", input: ["text", "image"], contextWindow: 200_000 },
				{ id: "text", provider: "fake", input: ["text"], contextWindow: 100_000 },
			],
			find: (_provider: string, id: string) => ({
				id,
				provider: "fake",
				input: id === "text" ? ["text"] : ["text", "image"],
				contextWindow: 100_000,
			}),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake", headers: {} }),
		},
		hasUI: true,
		mode: "tui",
		getContextUsage: () => ({ tokens }),
		ui: { notify: vi.fn(), select: vi.fn() },
	})
	Object.assign(ctx.sessionManager, { getBranch: () => images })
	return { pi, trigger, setModel, ctx, commands, tools }
}

function compactedImageBranch(): SessionEntry[] {
	return [
		{
			type: "compaction",
			id: "compact",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "Older context summarized.",
			firstKeptEntryId: "image-message",
			tokensBefore: 150_000,
		},
		{
			type: "message",
			id: "image-message",
			parentId: "compact",
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: [
					{ type: "text", text: "retained image" },
					{ type: "image", data: "cG5nLWRhdGE=", mimeType: "image/png" },
				],
				timestamp: 0,
			},
		},
	]
}

describe("compaction and retained-image stripping", () => {
	let attributionDir: string
	beforeEach(() => {
		attributionDir = mkdtempSync(join(tmpdir(), "strip-model-integration-"))
		vi.stubEnv("PI_CODING_AGENT_DIR", attributionDir)
	})
	afterEach(async () => {
		await flushWorkSummaries()
		vi.unstubAllEnvs()
		rmSync(attributionDir, { recursive: true, force: true })
	})

	it("uses descriptions before activating a text-only target", async () => {
		completeMock.mockReset().mockResolvedValue({ content: [{ type: "text", text: "a retained image description" }] })
		const { trigger, setModel, ctx } = harness(compactedImageBranch())
		const select = vi
			.fn()
			.mockResolvedValueOnce("Compact conversation and continue")
			.mockResolvedValueOnce("Strip images and switch")
		Object.assign(ctx.ui, { select })
		Object.assign(ctx, {
			compact: (options: Parameters<typeof ctx.compact>[0]) => {
				const completion = (async () => {
					await trigger("session_compact", { type: "session_compact" }, ctx)
					options?.onComplete?.({} as never)
				})()
				Object.assign(ctx, { getContextUsage: () => ({ tokens: 10_000 }) })
				return completion
			},
		})

		await trigger(
			"model_select",
			{
				type: "model_select",
				model: { id: "text", provider: "fake", input: ["text"], contextWindow: 100_000 },
				previousModel: { id: "vision", provider: "fake", input: ["text", "image"], contextWindow: 200_000 },
				source: "set",
			},
			ctx,
		)

		expect(select).toHaveBeenCalledTimes(2)
		expect(completeMock).toHaveBeenCalledOnce()
		expect(setModel.mock.calls.map(([model]) => model.id)).toEqual(["vision", "text"])
		expect(sessionHasImages()).toBe(false)
		const projection = await trigger<{ messages: ReturnType<typeof getLatestMessages> }>(
			"context",
			{ messages: getLatestMessages() },
			{ ...ctx, model: { input: ["text"] } },
		)
		expect(hasImages(projection?.messages ?? getLatestMessages())).toBe(false)
		expect(JSON.stringify(projection?.messages)).toContain("a retained image description")
		expect(JSON.stringify(projection?.messages)).not.toContain("cG5nLWRhdGE=")
	})

	it("keeps partial descriptions and placeholders when analysis is followed by set_model", async () => {
		completeMock
			.mockReset()
			.mockResolvedValueOnce({ content: [{ type: "text", text: "successful image description" }] })
			.mockRejectedValueOnce(new Error("second image description unavailable"))
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
		const images = compactedImageBranch()
		images.push({
			type: "message",
			id: "second-image-message",
			parentId: "image-message",
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: [{ type: "image", data: "c2Vjb25kLWltYWdl", mimeType: "image/png" }],
				timestamp: 0,
			},
		})
		const { trigger, setModel, ctx, commands, tools } = harness(images, 10_000)
		const stripCommand = commands.get("strip-images")
		const setModelTool = tools.get("set_model")
		if (!stripCommand || !setModelTool) throw new Error("image commands were not registered")
		await stripCommand.handler("", ctx as never)
		expect(sessionHasImages()).toBe(false)

		const result = await setModelTool.execute("set-model", { model: "fake/text" }, undefined, undefined, ctx as never)

		expect(completeMock).toHaveBeenCalledTimes(2)
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("")
		expect(setModel).toHaveBeenCalledOnce()
		expect(text).toContain("Switched to model fake/text")
		const projection = await trigger<{ messages: ReturnType<typeof getLatestMessages> }>(
			"context",
			{ messages: getLatestMessages() },
			{ ...ctx, model: { input: ["text"] } },
		)
		expect(hasImages(projection?.messages ?? getLatestMessages())).toBe(false)
		expect(JSON.stringify(projection?.messages)).toContain("successful image description")
		expect(JSON.stringify(projection?.messages)).toContain("image removed")
		expect(ctx.ui.select).not.toHaveBeenCalled()
		diagnostic.mockRestore()
	})

	it.each([
		"context",
		"session_start",
	] as const)("does not commit after a %s invalidates analysis", async (eventType) => {
		completeMock.mockReset()
		const { trigger, ctx, commands } = harness(compactedImageBranch(), 10_000)
		let releaseAuth!: () => void
		const authStarted = vi.fn()
		const authenticated = new Promise<void>((resolve) => {
			releaseAuth = resolve
		})
		Object.assign(ctx.modelRegistry, {
			getApiKeyAndHeaders: async () => {
				authStarted()
				await authenticated
				return { ok: true, apiKey: "fake", headers: {} }
			},
		})
		const command = commands.get("strip-images")
		if (!command) throw new Error("strip-images command was not registered")
		const pending = command.handler("", ctx as never)
		await vi.waitFor(() => expect(authStarted).toHaveBeenCalled())

		if (eventType === "context") {
			await trigger(
				"context",
				{
					messages: [
						{
							role: "user",
							content: [{ type: "image", data: "bmV3ZXItaW1hZ2U=", mimeType: "image/png" }],
							timestamp: 0,
						},
					],
				},
				ctx,
			)
		} else {
			await trigger("session_start", { type: "session_start" }, ctx)
		}
		releaseAuth()
		await pending

		expect(completeMock).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Could not load the latest session images"),
			"error",
		)
		expect(sessionHasImages()).toBe(eventType === "context")
	})
})
