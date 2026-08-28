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
	buildHermesFallbackProviders,
	buildHermesModelConfig,
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
		spawnSync: vi.fn(),
	}
})

describe("buildHermesModelConfig", () => {
	it("uses the custom provider, kimchi base URL and ${KIMCHI_API_KEY} placeholder", () => {
		const config = buildHermesModelConfig(TEST_MODELS) as {
			provider: string
			base_url: string
			api_key: string
			default: string
		}
		expect(config.provider).toBe("custom")
		expect(config.base_url).toBe("https://llm.kimchi.dev/openai/v1")
		expect(config.api_key).toBe("${KIMCHI_API_KEY}")
		expect(config.default).toBe("kimchi/kimi-k2.6")
	})

	it("throws when given an empty model list", () => {
		expect(() => buildHermesModelConfig([])).toThrow(/No models/)
	})

	it("falls back to the first model when the main role cannot be resolved", () => {
		const onlyTextModel = {
			...TEST_MODELS[0],
			slug: "lonely-text-model",
			input_modalities: ["text"] as Array<"text" | "image">,
		}
		// Build a list where every model is text-only and not vision-capable;
		// resolveModelRole still picks the first serverless model.
		const config = buildHermesModelConfig([onlyTextModel]) as { default: string }
		expect(config.default.startsWith("kimchi/")).toBe(true)
	})
})

describe("buildHermesFallbackProviders", () => {
	it("emits one entry per non-main fallback role using key_env", () => {
		const fallbacks = buildHermesFallbackProviders(TEST_MODELS)
		expect(fallbacks).toEqual([
			{
				provider: "custom",
				model: "kimchi/nemotron-3-ultra-fp4",
				base_url: "https://llm.kimchi.dev/openai/v1",
				key_env: "KIMCHI_API_KEY",
			},
			{
				provider: "custom",
				model: "kimchi/minimax-m2.7",
				base_url: "https://llm.kimchi.dev/openai/v1",
				key_env: "KIMCHI_API_KEY",
			},
		])
	})

	it("never uses api_key (uses key_env so Hermes reads ~/.hermes/.env at runtime)", () => {
		const fallbacks = buildHermesFallbackProviders(TEST_MODELS) as Array<Record<string, unknown>>
		for (const entry of fallbacks) {
			expect(entry.api_key).toBeUndefined()
			expect(entry.key_env).toBe("KIMCHI_API_KEY")
		}
	})

	it("dedupes when coding and sub resolve to the same model", () => {
		// Only one non-main serverless model — both `coding` and `sub`
		// roles resolve to it, so the list must dedupe.
		const modelsWithDuplicates: typeof TEST_MODELS = [
			TEST_MODELS[0], // kimi-k2.6 (main, vision-capable serverless)
			TEST_MODELS[2], // nemotron-3-ultra-fp4 (only non-main serverless)
		]
		const fallbacks = buildHermesFallbackProviders(modelsWithDuplicates) as Array<{ model: string }>
		const models = fallbacks.map((f) => f.model)
		expect(models).toEqual(["kimchi/nemotron-3-ultra-fp4"])
	})

	it("throws when given an empty model list", () => {
		expect(() => buildHermesFallbackProviders([])).toThrow(/No models/)
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
		expect(tool?.installArgs).toEqual(["--skip-setup", "--non-interactive", "--skip-browser", "--no-skills"])
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

	it("writes a config.yaml with the model + fallback_providers shape Hermes recognises", async () => {
		const tool = byId("hermes")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const written = parseYaml(readFileSync(join(tmp, ".hermes", "config.yaml"), "utf-8")) as Record<string, unknown>
		const model = written.model as Record<string, unknown>
		expect(model.provider).toBe("custom")
		expect(model.base_url).toBe("https://llm.kimchi.dev/openai/v1")
		expect(model.api_key).toBe("${KIMCHI_API_KEY}")
		expect(model.default).toBe("kimchi/kimi-k2.6")

		const fallbacks = written.fallback_providers as Array<Record<string, unknown>>
		expect(Array.isArray(fallbacks)).toBe(true)
		expect(fallbacks.length).toBeGreaterThan(0)
		const models = fallbacks.map((f) => f.model as string)
		expect(models).toContain("kimchi/nemotron-3-ultra-fp4")
		expect(models).toContain("kimchi/minimax-m2.7")
		for (const entry of fallbacks) {
			expect(entry.provider).toBe("custom")
			expect(entry.key_env).toBe("KIMCHI_API_KEY")
			expect(entry.api_key).toBeUndefined()
		}
	})

	it("preserves unrelated existing user config keys when merging", async () => {
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
custom_user_key: keep-me
`
		writeFileSync(join(configDir, "config.yaml"), existing, "utf-8")

		const tool = byId("hermes")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const written = parseYaml(readFileSync(join(configDir, "config.yaml"), "utf-8")) as Record<string, unknown>
		// The new top-level model/fallback_providers keys must be present.
		expect((written.model as Record<string, unknown>).default).toBe("kimchi/kimi-k2.6")
		expect(Array.isArray(written.fallback_providers)).toBe(true)
		// Unrelated user keys must survive untouched.
		expect(written.custom_user_key).toBe("keep-me")
		const agents = (written.agents as Record<string, unknown>).defaults as Record<string, unknown>
		const userModel = agents.model as Record<string, unknown>
		expect(userModel.temperature).toBe(0.7)
		expect(userModel.fallbacks).toEqual(["other/model"])
		const userCatalog = agents.models as Record<string, unknown>
		expect(userCatalog["other/model"]).toEqual({ alias: "Other" })
	})

	it("creates a fresh config.yaml when none exists", async () => {
		const tool = byId("hermes")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const configPath = join(tmp, ".hermes", "config.yaml")
		const written = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>
		const model = written.model as Record<string, unknown>
		expect(model.provider).toBe("custom")
		expect(typeof model.default).toBe("string")
		expect((model.default as string).startsWith("kimchi/")).toBe(true)

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
		vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as ReturnType<
			typeof childProcess.spawnSync
		>)
	})

	afterEach(() => {
		if (prevHome === undefined) process.env.HOME = undefined
		else process.env.HOME = prevHome
		rmSync(tmp, { recursive: true, force: true })
		vi.mocked(findBinary).mockClear()
		vi.mocked(childProcess.spawnSync).mockClear()
	})

	it("calls hermes config set for each model.* key and fallback_providers", async () => {
		const tool = byId("hermes")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const calls = vi.mocked(childProcess.spawnSync).mock.calls
		const configSet = (path: string) =>
			calls.find((c) => {
				const args = c[1] as string[] | undefined
				return args && args[0] === "config" && args[1] === "set" && args[2] === path
			})

		expect(configSet("model.provider")?.[1]).toEqual(["config", "set", "model.provider", "custom"])
		expect(configSet("model.base_url")?.[1]).toEqual([
			"config",
			"set",
			"model.base_url",
			"https://llm.kimchi.dev/openai/v1",
		])
		expect(configSet("model.api_key")?.[1]).toEqual(["config", "set", "model.api_key", "${KIMCHI_API_KEY}"])
		expect(configSet("model.default")?.[1]).toEqual(["config", "set", "model.default", "kimchi/kimi-k2.6"])

		const fallbackSetCall = configSet("fallback_providers")
		expect(fallbackSetCall).toBeDefined()
		const fallbackPayload = JSON.parse((fallbackSetCall?.[1] as string[])[3]) as Array<Record<string, unknown>>
		expect(Array.isArray(fallbackPayload)).toBe(true)
		expect(fallbackPayload.length).toBeGreaterThan(0)
		const models = fallbackPayload.map((f) => f.model as string)
		expect(models).toContain("kimchi/nemotron-3-ultra-fp4")
		expect(models).toContain("kimchi/minimax-m2.7")
		for (const entry of fallbackPayload) {
			expect(entry.provider).toBe("custom")
			expect(entry.key_env).toBe("KIMCHI_API_KEY")
			expect(entry.api_key).toBeUndefined()
		}

		const envContent = readFileSync(join(tmp, ".hermes", ".env"), "utf-8")
		expect(envContent).toBe("KIMCHI_API_KEY=test-key-123\n")
	})

	it("does not restart or onboard the Hermes gateway", async () => {
		const tool = byId("hermes")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const calls = vi.mocked(childProcess.spawnSync).mock.calls
		const restartCall = calls.find((c) => {
			const args = c[1] as string[] | undefined
			return args && args[0] === "gateway" && args[1] === "restart"
		})
		expect(restartCall).toBeUndefined()
		const onboardCall = calls.find((c) => {
			const args = c[1] as string[] | undefined
			return args && args[0] === "onboard"
		})
		expect(onboardCall).toBeUndefined()
	})

	it("does not write to the legacy models.providers / agents.defaults paths", async () => {
		const tool = byId("hermes")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const calls = vi.mocked(childProcess.spawnSync).mock.calls
		const legacyCall = calls.find((c) => {
			const args = c[1] as string[] | undefined
			return (
				args &&
				args[0] === "config" &&
				args[1] === "set" &&
				(args[2] === "models.providers.kimchi" ||
					args[2] === "agents.defaults.model.primary" ||
					args[2] === "agents.defaults.model.fallbacks" ||
					args[2] === "agents.defaults.models")
			)
		})
		expect(legacyCall).toBeUndefined()
	})
})
