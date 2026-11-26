import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, type StartAcpFixtureOptions, startAcpFixture } from "./support/acp-fixture.js"

const ALPHA_REF = "fake/alpha"
const BETA_REF = "fake/beta"
const MODEL_EFFORT_META = { "kimchi.dev": { modelEffort: 1 } }
const SET_MODEL_EFFORT = "_kimchi.dev/set_model_effort"

const CATALOG = [
	{
		slug: "alpha",
		displayName: "Alpha",
		provider: "fake",
		reasoning: true,
		input: ["text"],
		contextWindow: 64_000,
		maxTokens: 1_024,
		metadata: { thinking_levels: ["low", "high", "max"] },
	},
	{
		slug: "beta",
		displayName: "Beta",
		provider: "fake",
		reasoning: true,
		input: ["text"],
		contextWindow: 64_000,
		maxTokens: 1_024,
		metadata: { thinking_levels: ["low", "high"] },
	},
]

const fixtures: AcpFixture[] = []
const retainedDirs = new Set<string>()

async function start(options: StartAcpFixtureOptions): Promise<AcpFixture> {
	const { seedHome, ...rest } = options
	const fixture = await startAcpFixture({
		...rest,
		seedHome: (homeDir, workDir, fakeBaseUrl) => {
			seedHome?.(homeDir, workDir, fakeBaseUrl)
			seedModelThinkingLevels(homeDir, options.models)
		},
	})
	fixtures.push(fixture)
	retainedDirs.add(fixture.homeDir)
	retainedDirs.add(fixture.workDir)
	return fixture
}

async function stop(fixture: AcpFixture): Promise<void> {
	const index = fixtures.indexOf(fixture)
	if (index >= 0) fixtures.splice(index, 1)
	await fixture.stop()
}

/** Match the curated metadata and provider map that the real model builder
 * derives before thinkingSelection reads the local models.json. */
function seedModelThinkingLevels(homeDir: string, models: StartAcpFixtureOptions["models"]): void {
	const path = join(homeDir, ".config", "kimchi", "harness", "models.json")
	const catalog = JSON.parse(readFileSync(path, "utf-8")) as {
		providers: Record<string, { models?: Array<Record<string, unknown>> }>
	}
	for (const model of models ?? []) {
		const rawLevels = model.metadata?.thinking_levels
		if (!Array.isArray(rawLevels) || !rawLevels.every((level) => typeof level === "string")) continue
		const levels = rawLevels as string[]
		for (const provider of Object.values(catalog.providers)) {
			const target = provider.models?.find((candidate) => candidate.id === model.slug)
			if (!target) continue
			target.thinkingLevels = levels
			target.thinkingLevelMap = Object.fromEntries(levels.map((level) => [level, level]))
		}
	}
	writeFileSync(path, JSON.stringify(catalog, null, "\t"))
}

afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) await fixture.stop()
	for (const dir of retainedDirs) rmSync(dir, { recursive: true, force: true })
	retainedDirs.clear()
})

function configPath(homeDir: string): string {
	return join(homeDir, ".config", "kimchi", "config.json")
}

function seedDefaults(homeDir: string, modelEffortDefaults: unknown): void {
	const path = configPath(homeDir)
	const config = JSON.parse(readFileSync(path, "utf-8"))
	config.modelEffortDefaults = modelEffortDefaults
	writeFileSync(path, JSON.stringify(config, null, "\t"))
}

function readDefaults(homeDir: string): unknown {
	return JSON.parse(readFileSync(configPath(homeDir), "utf-8")).modelEffortDefaults
}

function readDefaultModel(homeDir: string): unknown {
	const path = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	return JSON.parse(readFileSync(path, "utf-8")).defaultModel
}

function readSessionEffortEntries(homeDir: string, sessionId: string): unknown[] {
	const root = join(homeDir, ".config", "kimchi", "harness", "sessions")
	const log = readdirSync(root)
		.flatMap((dir) => readdirSync(join(root, dir)).map((file) => join(root, dir, file)))
		.find((file) => file.endsWith(`_${sessionId}.jsonl`))
	if (!log) throw new Error(`Missing session log for ${sessionId}`)
	return readFileSync(log, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "custom" && entry.customType === "model_effort_selection")
		.map((entry) => entry.data)
}

function currentEffort(response: unknown): string | undefined {
	const options = (response as { configOptions?: acp.SessionConfigOption[] }).configOptions
	return options?.find((option) => option.id === "reasoning_effort")?.currentValue
}

function currentModel(response: unknown): string | undefined {
	const options = (response as { configOptions?: acp.SessionConfigOption[] }).configOptions
	return options?.find((option) => option.id === "model")?.currentValue
}

function modelRow(response: unknown, modelId: string): acp.SessionConfigSelectOption {
	const options = (response as { configOptions?: acp.SessionConfigOption[] }).configOptions
	const model = options?.find((option) => option.id === "model")
	if (model?.type !== "select") throw new Error("model select option missing")
	const row = model.options.find((option) => "value" in option && option.value === modelId)
	if (!row || !("value" in row)) throw new Error(`model row ${modelId} missing`)
	return row
}

function rowEffort(response: unknown, modelId: string): Record<string, unknown> | undefined {
	const meta = modelRow(response, modelId)._meta?.["kimchi.dev"] as
		| { modelEffort?: Record<string, unknown> }
		| undefined
	return meta?.modelEffort
}

async function newEffortSession(fixture: AcpFixture, appMode: "chat" | "design" | "code") {
	return fixture.conn.request("session/new", {
		cwd: fixture.workDir,
		mcpServers: [],
		_meta: { "kimchi.dev": { appMode } },
	})
}

async function selectModel(fixture: AcpFixture, sessionId: string, modelId: string) {
	return fixture.conn.request("session/set_config_option", {
		sessionId,
		configId: "model",
		value: modelId,
	})
}

async function setStandardEffort(fixture: AcpFixture, sessionId: string, value: string) {
	return fixture.conn.request("session/set_config_option", {
		sessionId,
		configId: "reasoning_effort",
		value,
	})
}

async function setFreshEffort(
	fixture: AcpFixture,
	sessionId: string,
	appMode: "chat" | "design" | "code",
	modelId: string,
	value: string,
) {
	return fixture.conn.request(SET_MODEL_EFFORT, { sessionId, appMode, modelId, value })
}

describe("ACP integration — model Effort persistence", () => {
	it("persists App-mode defaults and per-model session selections across a CLI restart", async () => {
		const first = await start({
			artifactName: "model-effort-persistence-first",
			models: CATALOG,
			defaultModel: "alpha",
			responses: [{ stream: ["Persisted turn."] }],
			clientMeta: MODEL_EFFORT_META,
			keepDirsOnStop: true,
		})
		const chat = await newEffortSession(first, "chat")
		const code = await newEffortSession(first, "code")

		const chatLow = await setFreshEffort(first, chat.sessionId, "chat", ALPHA_REF, "low")
		expect(currentEffort(chatLow)).toBe("low")
		expect(rowEffort(chatLow, ALPHA_REF)).toMatchObject({
			availability: "multiple",
			levels: ["low", "high", "max"],
			currentValue: "low",
			defaultValue: "low",
		})
		const codeHigh = await setFreshEffort(first, code.sessionId, "code", ALPHA_REF, "high")
		expect(currentEffort(codeHigh)).toBe("high")
		expect(rowEffort(codeHigh, ALPHA_REF)).toMatchObject({ currentValue: "high", defaultValue: "high" })
		expect(currentEffort(await newEffortSession(first, "chat"))).toBe("low")
		expect(currentEffort(await newEffortSession(first, "code"))).toBe("high")

		await selectModel(first, chat.sessionId, BETA_REF)
		expect(currentEffort(await setStandardEffort(first, chat.sessionId, "high"))).toBe("high")
		expect(currentEffort(await selectModel(first, chat.sessionId, ALPHA_REF))).toBe("low")
		expect(currentEffort(await selectModel(first, chat.sessionId, BETA_REF))).toBe("high")
		const turn = await first.conn.request("session/prompt", {
			sessionId: chat.sessionId,
			prompt: [{ type: "text", text: "Persist this session" }],
		})
		expect(turn.stopReason).toBe("end_turn")
		expect(readDefaults(first.homeDir)).toEqual({
			chat: { [ALPHA_REF]: "low" },
			code: { [ALPHA_REF]: "high" },
		})
		expect(readSessionEffortEntries(first.homeDir, chat.sessionId)).toEqual([
			{ modelId: ALPHA_REF, value: "high" },
			{ modelId: ALPHA_REF, value: "low" },
			{ modelId: BETA_REF, value: "low" },
			{ modelId: BETA_REF, value: "high" },
		])
		const persistedDefaults = readDefaults(first.homeDir)
		const { homeDir, workDir } = first
		await stop(first)

		const second = await start({
			artifactName: "model-effort-persistence-second",
			models: CATALOG,
			defaultModel: "alpha",
			responses: [],
			clientMeta: MODEL_EFFORT_META,
			homeDirOverride: homeDir,
			workDirOverride: workDir,
			seedHome: (home) => seedDefaults(home, persistedDefaults),
		})
		const loaded = await second.conn.request("session/load", {
			sessionId: chat.sessionId,
			cwd: workDir,
			mcpServers: [],
			_meta: { "kimchi.dev": { appMode: "chat" } },
		})
		expect(currentModel(loaded)).toBe(BETA_REF)
		expect(currentEffort(loaded)).toBe("high")
		const reselectedAlpha = await selectModel(second, chat.sessionId, ALPHA_REF)
		expect(currentEffort(reselectedAlpha)).toBe("low")
		expect(rowEffort(reselectedAlpha, ALPHA_REF)).toMatchObject({ currentValue: "low", defaultValue: "low" })

		const freshCode = await newEffortSession(second, "code")
		expect(currentEffort(await selectModel(second, freshCode.sessionId, ALPHA_REF))).toBe("high")
	})

	it("keeps Effort-only model switches from overwriting the saved default model", async () => {
		const fixture = await start({
			artifactName: "model-effort-session-only-switch",
			models: CATALOG,
			defaultModel: "alpha",
			responses: [],
			clientMeta: MODEL_EFFORT_META,
		})
		const chat = await newEffortSession(fixture, "chat")

		const result = await setFreshEffort(fixture, chat.sessionId, "chat", BETA_REF, "low")

		expect(currentModel(result)).toBe(BETA_REF)
		expect(readDefaultModel(fixture.homeDir)).toBe("alpha")
		await selectModel(fixture, chat.sessionId, BETA_REF)
		expect(readDefaultModel(fixture.homeDir)).toBe("beta")
	})

	it("resolves persisted values to a supported higher level, then a lower level", async () => {
		const models = [
			{
				...CATALOG[0],
				metadata: { thinking_levels: ["low", "high"] },
			},
		]
		const fixture = await start({
			artifactName: "model-effort-persistence-fallback",
			models,
			defaultModel: "alpha",
			responses: [],
			clientMeta: MODEL_EFFORT_META,
			seedHome: (home) =>
				seedDefaults(home, {
					chat: { [ALPHA_REF]: "minimal" },
					code: { [ALPHA_REF]: "max" },
				}),
		})

		const chat = await newEffortSession(fixture, "chat")
		expect(currentEffort(chat)).toBe("low")
		expect(rowEffort(chat, ALPHA_REF)).toMatchObject({ currentValue: "low", defaultValue: "low" })
		const chatOptions = chat.configOptions?.find((option) => option.id === "reasoning_effort")
		expect(chatOptions?.category).toBe("model_config")
		expect(currentEffort(chat)).toBeOneOf(
			chatOptions?.type === "select" ? chatOptions.options.map((option) => option.value) : [],
		)

		const code = await newEffortSession(fixture, "code")
		expect(currentEffort(code)).toBe("high")
		expect(rowEffort(code, ALPHA_REF)).toMatchObject({ currentValue: "high", defaultValue: "high" })
		const codeOptions = code.configOptions?.find((option) => option.id === "reasoning_effort")
		expect(currentEffort(code)).toBeOneOf(
			codeOptions?.type === "select" ? codeOptions.options.map((option) => option.value) : [],
		)
	})

	it("passes configured aliases and other-virtual identity through the real model registry", async () => {
		const family = { ...CATALOG[0], slug: "family", displayName: "Family alias" }
		const fixture = await start({
			artifactName: "model-effort-configured-virtual",
			models: [CATALOG[0], family],
			defaultModel: "alpha",
			responses: [],
			clientMeta: MODEL_EFFORT_META,
			seedHome: (home) => {
				const path = join(home, ".config", "kimchi", "harness", "models.json")
				const catalog = JSON.parse(readFileSync(path, "utf-8"))
				for (const provider of Object.values(catalog.providers) as Array<{ models?: Array<Record<string, unknown>> }>) {
					const model = provider.models?.find((candidate) => candidate.id === "family")
					if (model) Object.assign(model, { searchAliases: ["family", "router"], virtual: "other" })
				}
				writeFileSync(path, JSON.stringify(catalog, null, "\t"))
			},
		})

		const session = await newEffortSession(fixture, "chat")

		expect(rowEffort(session, "fake/family")).toEqual({
			availability: "routed",
			currentValue: null,
			defaultValue: null,
			virtual: "other",
			searchAliases: ["family", "router"],
		})
	})

	it("keeps legacy behavior for non-opt-in clients without new persistence", async () => {
		const fixture = await start({
			artifactName: "model-effort-persistence-no-opt-in",
			models: CATALOG,
			defaultModel: "alpha",
			settings: { defaultThinkingLevel: "high" },
			responses: [{ stream: ["Legacy turn."] }],
			seedHome: (home) => seedDefaults(home, { chat: { [ALPHA_REF]: "max" } }),
		})
		const session = await newEffortSession(fixture, "chat")

		expect(currentEffort(session)).toBe("high")
		expect(modelRow(session, ALPHA_REF)._meta).toBeUndefined()
		expect(session.configOptions?.find((option) => option.id === "reasoning_effort")?.category).toBe("thought_level")
		const legacyLow = await setStandardEffort(fixture, session.sessionId, "low")
		expect(currentEffort(legacyLow)).toBe("low")
		expect(modelRow(legacyLow, ALPHA_REF)._meta).toBeUndefined()
		expect(currentEffort(await selectModel(fixture, session.sessionId, BETA_REF))).toBe("high")
		expect(currentEffort(await selectModel(fixture, session.sessionId, ALPHA_REF))).toBe("high")
		const turn = await fixture.conn.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "Keep the legacy session behavior" }],
		})
		expect(turn.stopReason).toBe("end_turn")
		expect(readSessionEffortEntries(fixture.homeDir, session.sessionId)).toEqual([])
		expect(readDefaults(fixture.homeDir)).toEqual({ chat: { [ALPHA_REF]: "max" } })
		await expect(setFreshEffort(fixture, session.sessionId, "chat", ALPHA_REF, "max")).rejects.toMatchObject({
			code: -32601,
		})
		expect(readDefaults(fixture.homeDir)).toEqual({ chat: { [ALPHA_REF]: "max" } })
	})
})
