/**
 * The `kimchi_build` entry reaches the session JSONL on disk.
 *
 * Drives a real `AgentSession` (file-backed `SessionManager`, stubbed provider)
 * with the production build-info extension, then reads the persisted file.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai"
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { afterEach, expect, it } from "vitest"
import buildInfoExtension, { KIMCHI_BUILD_ENTRY_TYPE } from "./build-info.js"

const model: Model<Api> = {
	id: "build-info-stub-model",
	name: "Build Info Stub",
	api: "openai-completions",
	provider: "build-info-stub",
	baseUrl: "http://build-info-stub.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
}

function textStream(text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream()
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	}
	stream.push({ type: "start", partial: { ...message, content: [] } })
	stream.push({ type: "done", reason: "stop", message })
	return stream
}

let tmp: string | undefined

afterEach(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true })
	tmp = undefined
})

it("persists one kimchi_build entry in the session file", async () => {
	tmp = mkdtempSync(join(tmpdir(), "kimchi-build-info-session-"))
	const sessionDir = join(tmp, "sessions")

	const modelRuntime = await ModelRuntime.create({ authPath: join(tmp, "auth.json"), modelsPath: null })
	modelRuntime.registerProvider("build-info-stub", {
		name: "Build Info Stub",
		baseUrl: model.baseUrl,
		apiKey: "stub",
		api: "openai-completions",
		streamSimple: () => textStream("done"),
	})
	const loader = new DefaultResourceLoader({
		cwd: tmp,
		agentDir: tmp,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => "You are a build-info test.",
		appendSystemPromptOverride: () => [],
		extensionFactories: [buildInfoExtension],
	})
	await loader.reload()

	const { session } = await createAgentSession({
		cwd: tmp,
		agentDir: tmp,
		sessionManager: SessionManager.create(tmp, sessionDir),
		settingsManager: SettingsManager.create(tmp, tmp),
		model,
		modelRuntime,
		resourceLoader: loader,
	})
	await session.bindExtensions({
		onError: (err) => {
			throw new Error(`build-info extension failed to bind: ${err.error ?? err.extensionPath}`)
		},
	})
	await buildInfoExtension.settled()
	await session.prompt("hello")
	await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })

	const files = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"))
	expect(files).toHaveLength(1)
	const entries = readFileSync(join(sessionDir, files[0]), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
	const builds = entries.filter((entry) => entry.type === "custom" && entry.customType === KIMCHI_BUILD_ENTRY_TYPE)

	expect(builds).toHaveLength(1)
	// This test runs from the source checkout, so the build is a dev build with a commit.
	expect(builds[0].data).toMatchObject({
		schemaVersion: 1,
		channel: "dev",
		version: "dev",
		commit: expect.stringMatching(/^[0-9a-f]{40}$/),
	})
})
