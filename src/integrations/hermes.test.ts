import * as childProcess from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse as parseYaml } from "yaml"
import { TEST_MODELS } from "./__fixtures__/models.js"
import { findBinary } from "./detect.js"
import {
	asObject,
	buildHermesModelsCatalog,
	buildHermesProviderBlock,
	HERMES_CONFIG_PATH,
	HERMES_VERSION_MIN,
	HERMES_VERSION_REGEX,
	mergeFallbacks,
	mergeModelsCatalog,
	writeHermesEnv,
} from "./hermes.js"
import { byId } from "./registry.js"

vi.mock("./detect.js", async () => {
	const mockFindBinary = vi.fn().mockReturnValue(undefined)
	return { findBinary: mockFindBinary }
})

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual("node:child_process")
	return {
		...actual,
		execFileSync: vi.fn(),
		spawnSync: vi.fn(),
	}
})

describe("buildHermesProviderBlock", () => {
	it("uses the kimchi base URL and ${KIMCHI_API_KEY} placeholder", () => {
		const block = buildHermesProviderBlock(TEST_MODELS) as {
			baseUrl: string
			apiKey: string
			api: string
			models: unknown[]
		}
		expect(block.baseUrl).toBe("https://llm.kimchi.dev/openai/v1")
		expect(block.apiKey).toBe("${KIMCHI_API_KEY}")
		expect(block.api).toBe("openai-completions")
		expect(block.models.length).toBe(TEST_MODELS.length)
	})

	it("includes per-model id/name/contextWindow/maxTokens", () => {
		const block = buildHermesProviderBlock(TEST_MODELS) as {
			models: Array<{ id: string; name: string; contextWindow: number; maxTokens: number }>
		}
		const main = block.models.find((m) => m.id === "kimchi/kimi-k2.6")
		expect(main).toBeDefined()
		expect(main?.name).toBe("Kimi K2.6")
		expect(main?.contextWindow).toBe(262_144)
		expect(main?.maxTokens).toBe(32_768)
	})

	it("falls back to slug when display_name is empty", () => {
		const modelsWithEmptyName = [
			{ ...TEST_MODELS[0], display_name: "" },
			{ ...TEST_MODELS[1], display_name: "   " },
		]
		const block = buildHermesProviderBlock(modelsWithEmptyName) as {
			models: Array<{ id: string; name: string }>
		}
		expect(block.models[0].name).toBe(modelsWithEmptyName[0].slug)
		expect(block.models[1].name).toBe(modelsWithEmptyName[1].slug)
	})
})

describe("buildHermesModelsCatalog", () => {
	it("maps each model id to its display alias", () => {
		const catalog = buildHermesModelsCatalog(TEST_MODELS)
		expect(catalog["kimchi/kimi-k2.6"]).toEqual({ alias: "Kimi K2.6" })
		expect(catalog["kimchi/kimi-k2.5"]).toEqual({ alias: "Kimi K2.5" })
		expect(catalog["kimchi/nemotron-3-ultra-fp4"]).toEqual({ alias: "Nemotron 3 Ultra FP4" })
		expect(catalog["kimchi/minimax-m2.7"]).toEqual({ alias: "MiniMax M2.7" })
	})

	it("falls back to slug when display_name is empty", () => {
		const modelsWithEmptyName = [
			{ ...TEST_MODELS[0], display_name: "" },
			{ ...TEST_MODELS[1], display_name: "   " },
		]
		const catalog = buildHermesModelsCatalog(modelsWithEmptyName)
		expect(catalog["kimchi/kimi-k2.6"]).toEqual({ alias: "kimi-k2.6" })
		expect(catalog["kimchi/kimi-k2.5"]).toEqual({ alias: "kimi-k2.5" })
	})
})

describe("writeHermesEnv", () => {
	let tmp: string
	let prevHome: string | undefined

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "kimchi-hermes-test-"))
		prevHome = process.env.HOME
		process.env.HOME = tmp
	})

	afterEach(() => {
		if (prevHome === undefined) process.env.HOME = undefined
		else process.env.HOME = prevHome
		rmSync(tmp, { recursive: true, force: true })
	})

	it("creates the .env file with the API key when none exists", () => {
		mkdirSync(join(tmp, ".hermes"), { recursive: true })
		writeHermesEnv("test-key-123")
		expect(readFileSync(join(tmp, ".hermes", ".env"), "utf-8")).toBe("KIMCHI_API_KEY=test-key-123\n")
	})

	it("creates the parent directory if missing", () => {
		writeHermesEnv("fresh")
		expect(readFileSync(join(tmp, ".hermes", ".env"), "utf-8")).toBe("KIMCHI_API_KEY=fresh\n")
	})

	it("replaces an existing KIMCHI_API_KEY line in place, preserving other entries", () => {
		mkdirSync(join(tmp, ".hermes"), { recursive: true })
		writeFileSync(join(tmp, ".hermes", ".env"), "OTHER_VAR=keep-me\nKIMCHI_API_KEY=old-key\nALSO=keep\n", "utf-8")
		writeHermesEnv("new-key")
		expect(readFileSync(join(tmp, ".hermes", ".env"), "utf-8")).toBe(
			"OTHER_VAR=keep-me\nKIMCHI_API_KEY=new-key\nALSO=keep\n",
		)
	})

	it("appends KIMCHI_API_KEY when the file exists but doesn't have one yet", () => {
		mkdirSync(join(tmp, ".hermes"), { recursive: true })
		writeFileSync(join(tmp, ".hermes", ".env"), "OTHER=foo\n", "utf-8")
		writeHermesEnv("appended")
		expect(readFileSync(join(tmp, ".hermes", ".env"), "utf-8")).toBe("OTHER=foo\nKIMCHI_API_KEY=appended\n")
	})
})

describe("hermes tool registration", () => {
	it("registers itself with install metadata for the wizard", () => {
		const tool = byId("hermes")
		expect(tool).toBeDefined()
		expect(tool?.installUrl).toBe("https://hermes-agent.nousresearch.com/install.sh")
		expect(tool?.installArgs).toEqual(["--no-prompt", "--no-onboard"])
		expect(tool?.configPath).toBe(HERMES_CONFIG_PATH)
	})
	it("write() rejects an empty API key", async () => {
		const tool = byId("hermes")
		await expect(tool?.write("global", "", TEST_MODELS)).rejects.toThrow(/API key/)
	})
})

describe("asObject", () => {
	it("returns the object when passed a plain object", () => {
		expect(asObject({ foo: "bar" })).toEqual({ foo: "bar" })
	})
	it("returns {} for null", () => {
		expect(asObject(null)).toEqual({})
	})
	it("returns {} for arrays", () => {
		expect(asObject([1, 2, 3])).toEqual({})
	})
	it("returns {} for primitives", () => {
		expect(asObject("string")).toEqual({})
		expect(asObject(42)).toEqual({})
		expect(asObject(true)).toEqual({})
	})
	it("returns {} for undefined", () => {
		expect(asObject(undefined)).toEqual({})
	})
})

describe("mergeFallbacks", () => {
	it("appends new fallbacks to an existing array", () => {
		expect(mergeFallbacks(["a", "b"], ["c", "d"])).toEqual(["a", "b", "c", "d"])
	})
	it("dedupes entries across existing and new", () => {
		expect(mergeFallbacks(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"])
	})
	it("treats non-array existing as empty", () => {
		expect(mergeFallbacks(null, ["a"])).toEqual(["a"])
		expect(mergeFallbacks("string", ["a"])).toEqual(["a"])
		expect(mergeFallbacks({ foo: "bar" }, ["a"])).toEqual(["a"])
	})
	it("returns only new fallbacks when existing is undefined", () => {
		expect(mergeFallbacks(undefined, ["a", "b"])).toEqual(["a", "b"])
	})
})

describe("mergeModelsCatalog", () => {
	it("merges catalog entries into existing object", () => {
		expect(mergeModelsCatalog({ existing: true }, { newKey: "value" })).toEqual({
			existing: true,
			newKey: "value",
		})
	})
	it("new catalog entries take precedence over existing keys", () => {
		expect(mergeModelsCatalog({ same: "old" }, { same: "new" })).toEqual({ same: "new" })
	})
	it("treats non-object existing as empty", () => {
		expect(mergeModelsCatalog(null, { a: 1 })).toEqual({ a: 1 })
		expect(mergeModelsCatalog([1, 2], { a: 1 })).toEqual({ a: 1 })
		expect(mergeModelsCatalog("string", { a: 1 })).toEqual({ a: 1 })
	})
})

describe("hermes version constants", () => {
	it("exposes the minimum supported Hermes version", () => {
		expect(HERMES_VERSION_MIN).toBe("2026.1.0")
	})
	it("exposes a regex that matches `hermes --version` output", () => {
		const match = "Hermes 2026.1.2".match(HERMES_VERSION_REGEX)
		expect(match?.[1]).toBe("2026.1.2")
		expect(HERMES_VERSION_REGEX.test("hermes 2026.1.0")).toBe(false)
	})
})

describe("writeHermesDirect integration", () => {
	let tmp: string
	let prevHome: string | undefined

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "kimchi-hermes-direct-"))
		prevHome = process.env.HOME
		process.env.HOME = tmp
		vi.mocked(findBinary).mockReturnValue(undefined)
	})

	afterEach(() => {
		if (prevHome === undefined) process.env.HOME = undefined
		else process.env.HOME = prevHome
		rmSync(tmp, { recursive: true, force: true })
		vi.mocked(findBinary).mockClear()
	})

	it("writes valid YAML that preserves existing user config keys like temperature and fallbacks", async () => {
		const configDir = join(tmp, ".hermes")
		mkdirSync(configDir, { recursive: true })
		const existing = `agents:
  defaults:
    model:
      temperature: 0.7
      fallbacks:
        - other/model
    models:
      other/model:
        alias: Other
`
		writeFileSync(join(configDir, "config.yaml"), existing, "utf-8")

		const tool = byId("hermes")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const written = parseYaml(readFileSync(join(configDir, "config.yaml"), "utf-8")) as Record<string, unknown>
		const agents = (written.agents as Record<string, unknown>).defaults as Record<string, unknown>
		const model = agents.model as Record<string, unknown>

		expect(model.temperature).toBe(0.7)
		const fallbacks = model.fallbacks as string[]
		expect(fallbacks).toContain("other/model")
		expect(fallbacks).toContain("kimchi/nemotron-3-ultra-fp4")
		expect(fallbacks).toContain("kimchi/minimax-m2.7")

		const models = agents.models as Record<string, unknown>
		expect(models["other/model"]).toEqual({ alias: "Other" })
		expect(models["kimchi/kimi-k2.6"]).toBeDefined()

		const providers = ((written.models as Record<string, unknown>).providers as Record<string, unknown>)
			.kimchi as Record<string, unknown>
		expect(providers).toBeDefined()
		expect(providers.baseUrl).toBe("https://llm.kimchi.dev/openai/v1")
		expect(providers.apiKey).toBe("${KIMCHI_API_KEY}")
		expect(providers.api).toBe("openai-completions")
	})

	it("creates a fresh config.yaml when none exists", async () => {
		const tool = byId("hermes")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const configPath = join(tmp, ".hermes", "config.yaml")
		const written = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>
		const agents = (written.agents as Record<string, unknown>).defaults as Record<string, unknown>
		const model = agents.model as Record<string, unknown>
		expect(typeof model.primary).toBe("string")
		expect((model.primary as string).startsWith("kimchi/")).toBe(true)

		const envContent = readFileSync(join(tmp, ".hermes", ".env"), "utf-8")
		expect(envContent).toBe("KIMCHI_API_KEY=test-key-123\n")
	})
})

describe("writeHermesViaCLI integration", () => {
	let tmp: string
	let prevHome: string | undefined

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "kimchi-hermes-cli-"))
		prevHome = process.env.HOME
		process.env.HOME = tmp
		vi.mocked(findBinary).mockReturnValue("/usr/bin/hermes")
		vi.mocked(childProcess.execFileSync).mockReturnValue("not running")
		vi.mocked(childProcess.spawnSync).mockImplementation((_cmd: unknown, args: unknown) => {
			const cmdArgs = args as string[]
			if (cmdArgs[0] === "config" && cmdArgs[1] === "get" && cmdArgs[2] === "agents.defaults.model.fallbacks") {
				return { status: 0, stdout: JSON.stringify(["existing/model"]), stderr: "" } as ReturnType<
					typeof childProcess.spawnSync
				>
			}
			if (cmdArgs[0] === "config" && cmdArgs[1] === "get" && cmdArgs[2] === "agents.defaults.models") {
				return { status: 0, stdout: JSON.stringify({ "other/model": { alias: "Other" } }), stderr: "" } as ReturnType<
					typeof childProcess.spawnSync
				>
			}
			return { status: 0, stdout: "", stderr: "" } as ReturnType<typeof childProcess.spawnSync>
		})
	})

	afterEach(() => {
		if (prevHome === undefined) process.env.HOME = undefined
		else process.env.HOME = prevHome
		rmSync(tmp, { recursive: true, force: true })
		vi.mocked(findBinary).mockClear()
		vi.mocked(childProcess.execFileSync).mockClear()
		vi.mocked(childProcess.spawnSync).mockClear()
	})

	it("preserves existing fallbacks and other keys via CLI merge", async () => {
		const tool = byId("hermes")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const calls = vi.mocked(childProcess.spawnSync).mock.calls
		const fallbackSetCall = calls.find((c) => {
			const args = c[1] as string[] | undefined
			return args && args[0] === "config" && args[1] === "set" && args[2] === "agents.defaults.model.fallbacks"
		})
		expect(fallbackSetCall).toBeDefined()
		const mergedFallbacks = JSON.parse((fallbackSetCall?.[1] as string[])[3])
		expect(mergedFallbacks).toContain("existing/model")
		expect(mergedFallbacks).toContain("kimchi/nemotron-3-ultra-fp4")

		const modelsSetCall = calls.find((c) => {
			const args = c[1] as string[] | undefined
			return args && args[0] === "config" && args[1] === "set" && args[2] === "agents.defaults.models"
		})
		expect(modelsSetCall).toBeDefined()
		const mergedModels = JSON.parse((modelsSetCall?.[1] as string[])[3]) as Record<string, unknown>
		expect(mergedModels["other/model"]).toEqual({ alias: "Other" })
		expect(mergedModels["kimchi/kimi-k2.6"]).toBeDefined()
		expect(mergedModels["kimchi/nemotron-3-ultra-fp4"]).toBeDefined()

		const envContent = readFileSync(join(tmp, ".hermes", ".env"), "utf-8")
		expect(envContent).toBe("KIMCHI_API_KEY=test-key-123\n")
	})

	it("runs hermes gateway restart when the gateway is already running", async () => {
		vi.mocked(childProcess.execFileSync).mockReturnValue("gateway: running\n")
		const tool = byId("hermes")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const calls = vi.mocked(childProcess.spawnSync).mock.calls
		const restartCall = calls.find((c) => {
			const args = c[1] as string[] | undefined
			return args && args[0] === "gateway" && args[1] === "restart"
		})
		expect(restartCall).toBeDefined()
		const onboardCall = calls.find((c) => {
			const args = c[1] as string[] | undefined
			return args && args[0] === "onboard"
		})
		expect(onboardCall).toBeUndefined()
	})
})
