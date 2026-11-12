/**
 * runAgent end-to-end with a REAL child session — the original bug scenario.
 *
 * The loader-seam tests in subagent-resource-loader.test.ts prove factories +
 * persona + activation compose; this test closes the remaining gap by driving
 * runAgent itself: real SubagentResourceLoader, real createAgentSession, real
 * web extensions, the REAL embedded Researcher persona registry, and a scripted
 * model provider (the repo's resteer pattern: ModelRuntime.create +
 * registerProvider({ streamSimple })). The scripted model issues NO tool
 * calls — the point is what the child session was prepared with, captured at
 * the provider boundary: the outgoing request context carries the active tool
 * list, which must include web_search and web_fetch.
 *
 * Peripheral machine-state collaborators (env detection, prompt composition,
 * skill/memory/context files, telemetry config) are mocked exactly as in
 * agent-runner.test.ts. Everything in the extension/tool pipeline is real.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// --- Peripheral mocks (identical surface to agent-runner.test.ts) -----------

vi.mock("../../env.js", () => ({
	detectEnv: vi.fn().mockResolvedValue({ os: "linux", shell: "bash" }),
}))

vi.mock("../prompt/prompts.js", () => ({
	buildAgentPrompt: vi.fn().mockReturnValue("System prompt text"),
	formatTokenBudget: vi.fn().mockImplementation((n: number) => String(n)),
}))

vi.mock("../prompt/skill-loader.js", () => ({
	listAvailableSkillNames: vi.fn().mockReturnValue([]),
	preloadSkills: vi.fn().mockReturnValue([]),
}))

vi.mock("../prompt/brief-skill-loader.js", () => ({
	scanBriefSkills: vi.fn().mockResolvedValue({ available: [], matched: [] }),
	renderBriefSkillBlock: vi.fn().mockImplementation((m: { name: string }) => `AUTOLOAD-${m.name.toUpperCase()}`),
}))

vi.mock("../prompt/context.js", () => ({
	buildParentContext: vi.fn().mockReturnValue(undefined),
	extractText: vi.fn().mockImplementation((content: unknown) => (typeof content === "string" ? content : "")),
}))

vi.mock("../../tags.js", () => ({
	getCurrentPhase: vi.fn().mockReturnValue(undefined),
	setCurrentPhase: vi.fn(),
}))

vi.mock("../../memory/memory.js", () => ({
	buildMemoryBlock: vi.fn().mockReturnValue(""),
	buildReadOnlyMemoryBlock: vi.fn().mockReturnValue(""),
}))

vi.mock("../../prompt-construction/context-files.js", () => ({
	loadProjectContextFiles: vi.fn().mockReturnValue([]),
}))

vi.mock("../../telemetry/index.js", () => ({
	default: vi.fn().mockReturnValue(() => {}),
}))

vi.mock("../../../config.js", () => ({
	readTelemetryConfig: vi.fn().mockReturnValue({
		enabled: true,
		endpoint: "https://test/logs",
		metricsEndpoint: "https://test/metrics",
		headers: { Authorization: "Bearer test" },
		apiKey: "",
	}),
	resolveEndpoints: vi.fn(() => ({ platformApiUrl: "https://policy.test" })),
	loadConfig: vi.fn(() => ({})),
}))

vi.mock("../../orchestration/model-registry/guidelines/guidelines-resolver.js", () => ({
	buildPhaseGuidelinesSection: vi.fn().mockReturnValue(""),
}))

vi.mock("../../auto-model/index.js", () => ({
	createAutoModelRoutingExtension: vi.fn(() => () => {}),
}))

// --- Real pipeline under test ------------------------------------------------

import { registerAgents } from "../personas/agent-types.js"
import { AGENT_RESEARCHER } from "../personas/types.js"
import { type RunOptions, runAgent } from "./agent-runner.js"

const model: Model<Api> = {
	id: "stub-scripted",
	name: "Stub Scripted",
	api: "openai-completions",
	provider: "runagent-stub",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}
}

const FINAL_ANSWER = "INTEGRATION-FINAL: research complete with web tools wired."

/** Emit a full AssistantMessageEventStream for a plain text response. */
function textStream(text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream()
	const partial: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	}
	stream.push({ type: "start", partial })
	stream.push({ type: "text_start", contentIndex: 0, partial })
	const filled = { ...partial, content: [{ type: "text", text }] } as AssistantMessage
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: filled })
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: filled })
	const final = { ...filled, stopReason: "stop" } as AssistantMessage
	stream.push({ type: "done", reason: "stop", message: final })
	return stream
}

describe("runAgent — real child session with scripted model", () => {
	const tmpDirs: string[] = []
	let savedAgentDir: string | undefined

	function makeTmp(prefix: string) {
		const dir = mkdtempSync(join(tmpdir(), prefix))
		tmpDirs.push(dir)
		return dir
	}

	beforeAll(() => {
		savedAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
	})

	afterAll(() => {
		if (savedAgentDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
		else process.env.KIMCHI_CODING_AGENT_DIR = savedAgentDir
		for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	it("spawns the REAL Researcher into a real session whose active tools include web_search/web_fetch", {
		timeout: 60_000,
	}, async () => {
		// Isolated agent dir so resource gating reads test defaults, not the
		// developer machine's settings.
		process.env.KIMCHI_CODING_AGENT_DIR = makeTmp("kimchi-runagent-agentdir-")
		registerAgents(new Map()) // embedded defaults only — the real personas

		// Capture the tool set of every provider request. pi 2.x folds the
		// active tools into the transcript's system messages (toolsAdded /
		// toolsRemoved), so replay them: the final set IS the child session's
		// active-tool list — the observable endpoint of the wiring this PR fixes.
		const requestedToolNames: string[][] = []
		const streamSimple = (_m: Model<Api>, context: TranscriptContext) => {
			let active: string[] = []
			for (const msg of context.messages as Array<{
				toolsAdded?: { name: string }[]
				toolsRemoved?: { name: string }[]
			}>) {
				if (msg.toolsAdded) active.push(...msg.toolsAdded.map((t) => t.name))
				if (msg.toolsRemoved) active = active.filter((n) => !msg.toolsRemoved?.some((r) => r.name === n))
			}
			requestedToolNames.push(active)
			return textStream(FINAL_ANSWER)
		}
		const modelRuntime = await ModelRuntime.create({
			authPath: join(makeTmp("kimchi-runagent-auth-"), "auth.json"),
			modelsPath: null,
		})
		modelRuntime.registerProvider("runagent-stub", {
			name: "RunAgent Stub",
			baseUrl: model.baseUrl,
			apiKey: "stub",
			api: "openai-completions",
			streamSimple,
		})

		const cwd = makeTmp("kimchi-runagent-cwd-")
		const ctx = {
			cwd,
			model,
			modelRegistry: {
				find: vi.fn().mockReturnValue(undefined),
				getAvailable: vi.fn().mockReturnValue([model]),
				runtime: modelRuntime,
			},
			getSystemPrompt: vi.fn().mockReturnValue(""),
			sessionManager: {
				getSessionId: vi.fn().mockReturnValue("parent-session-1"),
				getSessionDir: vi.fn().mockReturnValue(undefined),
				getSessionFile: vi.fn().mockReturnValue(undefined),
			},
		}

		const result = await runAgent(
			ctx as unknown as Parameters<typeof runAgent>[0],
			AGENT_RESEARCHER,
			"research the thing",
			{ pi: { exec: vi.fn() } as unknown as RunOptions["pi"] },
		)

		expect(result.responseText).toContain("INTEGRATION-FINAL")
		expect(result.droppedToolNames).toBeUndefined()
		expect(requestedToolNames.length).toBeGreaterThan(0)
		expect(requestedToolNames[0]).toContain("web_search")
		expect(requestedToolNames[0]).toContain("web_fetch")
	})
})
