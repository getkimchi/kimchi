import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, type StartAcpFixtureOptions, startAcpFixture } from "./support/acp-fixture.js"

const ALPHA_REF = "fake/alpha"
const BETA_REF = "fake/beta"
const MODEL_THINKING_META = { "kimchi.dev": { modelThinking: 1 } }
const GET_MODEL_THINKING = "_kimchi.dev/get_model_thinking"
const SET_MODEL_THINKING = "_kimchi.dev/set_model_thinking"

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

function readConfig(homeDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(configPath(homeDir), "utf-8"))
}

function seedDefaults(homeDir: string, modelEffortDefaults: unknown): void {
	const config = readConfig(homeDir)
	config.modelEffortDefaults = modelEffortDefaults
	writeFileSync(configPath(homeDir), JSON.stringify(config, null, "\t"))
}

function readDefaults(homeDir: string): unknown {
	return readConfig(homeDir).modelEffortDefaults
}

function readDefaultModel(homeDir: string): unknown {
	const path = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	return JSON.parse(readFileSync(path, "utf-8")).defaultModel
}

function readSessionThinkingEntries(homeDir: string, sessionId: string): unknown[] {
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

function currentThinkingLevel(response: unknown): string | undefined {
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

function rowThinkingLevel(response: unknown, modelId: string): Record<string, unknown> | undefined {
	const meta = modelRow(response, modelId)._meta?.["kimchi.dev"] as
		| { modelThinking?: Record<string, unknown> }
		| undefined
	return meta?.modelThinking
}

async function newThinkingSession(fixture: AcpFixture, legacyMode?: "chat" | "design" | "code") {
	return fixture.conn.request("session/new", {
		cwd: fixture.workDir,
		mcpServers: [],
		...(legacyMode ? { _meta: { "kimchi.dev": { appMode: legacyMode } } } : {}),
	})
}

async function selectModel(fixture: AcpFixture, sessionId: string, modelId: string) {
	return fixture.conn.request("session/set_config_option", {
		sessionId,
		configId: "model",
		value: modelId,
	})
}

async function setStandardThinkingLevel(fixture: AcpFixture, sessionId: string, value: string) {
	return fixture.conn.request("session/set_config_option", {
		sessionId,
		configId: "reasoning_effort",
		value,
	})
}

async function setFreshThinkingLevel(fixture: AcpFixture, sessionId: string, modelId: string, value: string) {
	return fixture.conn.request(SET_MODEL_THINKING, { sessionId, modelId, value })
}

describe("ACP integration — model Thinking level persistence", () => {
	it("persists concrete-model defaults and per-model Session selections across a CLI restart", async () => {
		const first = await start({
			artifactName: "model-thinking-persistence-first",
			models: CATALOG,
			defaultModel: "alpha",
			responses: [{ stream: ["Persisted turn."] }],
			clientMeta: MODEL_THINKING_META,
			keepDirsOnStop: true,
		})
		const session = await newThinkingSession(first)
		const read = await first.conn.request(GET_MODEL_THINKING, { sessionId: session.sessionId })
		expect(read).toEqual({ configOptions: session.configOptions })

		const low = await setFreshThinkingLevel(first, session.sessionId, ALPHA_REF, "low")
		expect(currentThinkingLevel(low)).toBe("low")
		expect(rowThinkingLevel(low, ALPHA_REF)).toEqual({
			availability: "multiple",
			levels: ["low", "high", "max"],
			currentValue: "low",
		})
		expect(currentThinkingLevel(await newThinkingSession(first))).toBe("low")

		await selectModel(first, session.sessionId, BETA_REF)
		expect(currentThinkingLevel(await setStandardThinkingLevel(first, session.sessionId, "high"))).toBe("high")
		expect(currentThinkingLevel(await selectModel(first, session.sessionId, ALPHA_REF))).toBe("low")

		expect(currentThinkingLevel(await selectModel(first, session.sessionId, BETA_REF))).toBe("high")
		const turn = await first.conn.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "Persist this session" }],
		})
		expect(turn.stopReason).toBe("end_turn")
		expect(readDefaults(first.homeDir)).toEqual({ [ALPHA_REF]: "low" })
		expect(readSessionThinkingEntries(first.homeDir, session.sessionId)).toEqual([
			{ modelId: ALPHA_REF, value: "high" },
			{ modelId: ALPHA_REF, value: "low" },
			{ modelId: BETA_REF, value: "low" },
			{ modelId: BETA_REF, value: "high" },
		])
		const persistedDefaults = readDefaults(first.homeDir)
		const { homeDir, workDir } = first
		await stop(first)

		const second = await start({
			artifactName: "model-thinking-persistence-second",
			models: CATALOG,
			defaultModel: "alpha",
			responses: [],
			clientMeta: MODEL_THINKING_META,
			homeDirOverride: homeDir,
			workDirOverride: workDir,
			seedHome: (home) => seedDefaults(home, persistedDefaults),
		})
		const loaded = await second.conn.request("session/load", {
			sessionId: session.sessionId,
			cwd: workDir,
			mcpServers: [],
			_meta: { "kimchi.dev": { appMode: "chat" } },
		})
		expect(currentModel(loaded)).toBe(BETA_REF)
		expect(currentThinkingLevel(loaded)).toBe("high")
		const reselectedAlpha = await selectModel(second, session.sessionId, ALPHA_REF)
		expect(currentThinkingLevel(reselectedAlpha)).toBe("low")
		expect(rowThinkingLevel(reselectedAlpha, ALPHA_REF)).toEqual({
			availability: "multiple",
			levels: ["low", "high", "max"],
			currentValue: "low",
		})
		expect(currentThinkingLevel(await newThinkingSession(second))).toBe("low")
	})

	it("keeps Thinking level-only model switches from overwriting the saved default model", async () => {
		const fixture = await start({
			artifactName: "model-thinking-session-only-switch",
			models: CATALOG,
			defaultModel: "alpha",
			responses: [],
			clientMeta: MODEL_THINKING_META,
		})
		const session = await newThinkingSession(fixture)

		const result = await setFreshThinkingLevel(fixture, session.sessionId, BETA_REF, "low")

		expect(currentModel(result)).toBe(BETA_REF)
		expect(readDefaultModel(fixture.homeDir)).toBe("alpha")
		await selectModel(fixture, session.sessionId, BETA_REF)
		expect(readDefaultModel(fixture.homeDir)).toBe("beta")
	})

	it.each([
		{ stored: "minimal", expected: "low", direction: "higher" },
		{ stored: "max", expected: "high", direction: "lower" },
	])("resolves a persisted value to the nearest $direction supported level", async ({ stored, expected }) => {
		const models = [{ ...CATALOG[0], metadata: { thinking_levels: ["low", "high"] } }]
		const fixture = await start({
			artifactName: `model-thinking-persistence-fallback-${stored}`,
			models,
			defaultModel: "alpha",
			responses: [],
			clientMeta: MODEL_THINKING_META,
			seedHome: (home) => seedDefaults(home, { [ALPHA_REF]: stored }),
		})

		const session = await newThinkingSession(fixture)
		expect(currentThinkingLevel(session)).toBe(expected)
		expect(rowThinkingLevel(session, ALPHA_REF)).toEqual({
			availability: "multiple",
			levels: ["low", "high"],
			currentValue: expected,
		})
		const options = session.configOptions?.find((option) => option.id === "reasoning_effort")
		expect(options?.category).toBe("model_config")
		expect(currentThinkingLevel(session)).toBeOneOf(
			options?.type === "select" ? options.options.map((option) => option.value) : [],
		)
	})

	it("clears legacy default buckets without losing unrelated config or durable Session selections", async () => {
		const legacyDefaults = {
			chat: { [ALPHA_REF]: "max" },
			design: { [ALPHA_REF]: "high" },
			code: { [ALPHA_REF]: "max" },
			[BETA_REF]: "high",
		}
		const first = await start({
			artifactName: "model-thinking-persistence-legacy-first",
			models: CATALOG,
			defaultModel: "alpha",
			settings: { defaultThinkingLevel: "low" },
			responses: [{ stream: ["Persist session selections."] }],
			clientMeta: MODEL_THINKING_META,
			keepDirsOnStop: true,
			seedHome: (home) => {
				const config = readConfig(home)
				config.modelEffortDefaults = legacyDefaults
				config.unrelatedPreference = { keep: true }
				writeFileSync(configPath(home), JSON.stringify(config, null, "\t"))
			},
		})
		const created = await newThinkingSession(first, "code")
		const sessionEntries = [
			{ modelId: ALPHA_REF, value: "low" },
			{ modelId: ALPHA_REF, value: "max" },
		]

		expect(currentThinkingLevel(created)).toBe("low")
		expect(currentThinkingLevel(await setStandardThinkingLevel(first, created.sessionId, "max"))).toBe("max")
		const turn = await first.conn.request("session/prompt", {
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "Persist session selections" }],
		})
		expect(turn.stopReason).toBe("end_turn")
		expect(readDefaults(first.homeDir)).toEqual({ [BETA_REF]: "high" })
		expect(readConfig(first.homeDir)).toMatchObject({ unrelatedPreference: { keep: true } })
		expect(readSessionThinkingEntries(first.homeDir, created.sessionId)).toEqual(sessionEntries)

		const persistedConfig = readConfig(first.homeDir)
		const { homeDir, workDir } = first
		await stop(first)
		const second = await start({
			artifactName: "model-thinking-persistence-legacy-second",
			models: CATALOG,
			defaultModel: "alpha",
			responses: [],
			clientMeta: MODEL_THINKING_META,
			homeDirOverride: homeDir,
			workDirOverride: workDir,
			seedHome: (home) => writeFileSync(configPath(home), JSON.stringify(persistedConfig, null, "\t")),
		})
		const loaded = await second.conn.request("session/load", {
			sessionId: created.sessionId,
			cwd: workDir,
			mcpServers: [],
			_meta: { "kimchi.dev": { appMode: "chat" } },
		})

		expect(currentThinkingLevel(loaded)).toBe("max")
		expect(readDefaults(second.homeDir)).toEqual({ [BETA_REF]: "high" })
		expect(readConfig(second.homeDir)).toMatchObject({ unrelatedPreference: { keep: true } })
		expect(readSessionThinkingEntries(second.homeDir, created.sessionId)).toEqual(sessionEntries)
	})

	it("passes other-virtual identity through the real model registry without alias or default metadata", async () => {
		const family = { ...CATALOG[0], slug: "family", displayName: "Family alias" }
		const fixture = await start({
			artifactName: "model-thinking-configured-virtual",
			models: [CATALOG[0], family],
			defaultModel: "alpha",
			responses: [],
			clientMeta: MODEL_THINKING_META,
			seedHome: (home) => {
				const path = join(home, ".config", "kimchi", "harness", "models.json")
				const catalog = JSON.parse(readFileSync(path, "utf-8"))
				for (const provider of Object.values(catalog.providers) as Array<{ models?: Array<Record<string, unknown>> }>) {
					const model = provider.models?.find((candidate) => candidate.id === "family")
					if (model) Object.assign(model, { virtual: "other" })
				}
				writeFileSync(path, JSON.stringify(catalog, null, "\t"))
			},
		})

		const session = await newThinkingSession(fixture)
		const vendorMeta = modelRow(session, "fake/family")._meta?.["kimchi.dev"] as Record<string, unknown> | undefined
		expect(vendorMeta).not.toHaveProperty("searchAliases")
		expect(vendorMeta).not.toHaveProperty("defaultValue")

		expect(rowThinkingLevel(session, "fake/family")).toEqual({
			availability: "routed",
			currentValue: null,
			virtual: "other",
		})
	})

	it("keeps legacy behavior for non-opt-in clients without new persistence", async () => {
		const fixture = await start({
			artifactName: "model-thinking-persistence-no-opt-in",
			models: CATALOG,
			defaultModel: "alpha",
			settings: { defaultThinkingLevel: "high" },
			responses: [{ stream: ["Legacy turn."] }],
			seedHome: (home) => seedDefaults(home, { chat: { [ALPHA_REF]: "max" } }),
		})
		const session = await newThinkingSession(fixture)

		expect(currentThinkingLevel(session)).toBe("high")
		expect(modelRow(session, ALPHA_REF)._meta).toBeUndefined()
		expect(session.configOptions?.find((option) => option.id === "reasoning_effort")?.category).toBe("thought_level")
		const legacyLow = await setStandardThinkingLevel(fixture, session.sessionId, "low")
		expect(currentThinkingLevel(legacyLow)).toBe("low")

		expect(modelRow(legacyLow, ALPHA_REF)._meta).toBeUndefined()
		expect(currentThinkingLevel(await selectModel(fixture, session.sessionId, BETA_REF))).toBe("high")
		expect(currentThinkingLevel(await selectModel(fixture, session.sessionId, ALPHA_REF))).toBe("high")
		const turn = await fixture.conn.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "Keep the legacy session behavior" }],
		})
		expect(turn.stopReason).toBe("end_turn")
		expect(readSessionThinkingEntries(fixture.homeDir, session.sessionId)).toEqual([])
		expect(readDefaults(fixture.homeDir)).toEqual({ chat: { [ALPHA_REF]: "max" } })
		await expect(setFreshThinkingLevel(fixture, session.sessionId, ALPHA_REF, "max")).rejects.toMatchObject({
			code: -32601,
		})
		await expect(fixture.conn.request(GET_MODEL_THINKING, { sessionId: session.sessionId })).rejects.toMatchObject({
			code: -32601,
		})
		expect(readDefaults(fixture.homeDir)).toEqual({ chat: { [ALPHA_REF]: "max" } })
	})
})
