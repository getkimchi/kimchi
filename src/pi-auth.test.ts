import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { syncKimchiAuth } from "./extensions/login/flow.js"
import { syncPiAuth } from "./pi-auth.js"

const tempDirs: string[] = []

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

function model(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		contextWindow: 1000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}
}

function provider(models: ReturnType<typeof model>[]) {
	return {
		baseUrl: "https://example.invalid/openai/v1",
		apiKey: "$KIMCHI_API_KEY",
		api: "openai-completions",
		authHeader: true,
		models,
	}
}

describe("syncPiAuth", () => {
	it("reports the missing models configuration when storing a Kimchi key", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")

		await expect(syncPiAuth(authPath, modelsPath, "kimchi-key")).rejects.toThrow(
			`Models configuration is missing at ${modelsPath}`,
		)
	})

	it("creates Pi auth storage on first run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		writeFileSync(modelsPath, JSON.stringify({ providers: { "kimchi-dev": {} } }))

		await syncPiAuth(authPath, modelsPath, "kimchi-key")

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			"kimchi-dev": { type: "api_key", key: "kimchi-key" },
		})
	})

	it("stores the Kimchi key for every managed Pi provider", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				anthropic: { type: "api_key", key: "keep-me" },
				"kimchi-experimental": { type: "api_key", key: "old-kimchi-key" },
			}),
		)
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { "kimchi-dev": {}, "kimchi-dev/openai": {}, "kimchi-experimental": {}, ollama: {} },
			}),
		)

		await syncPiAuth(authPath, modelsPath, "kimchi-key")

		const credentials = JSON.parse(readFileSync(authPath, "utf-8"))
		expect(credentials).toEqual({
			anthropic: { type: "api_key", key: "keep-me" },
			"kimchi-dev": { type: "api_key", key: "kimchi-key" },
			"kimchi-dev/openai": { type: "api_key", key: "kimchi-key" },
			"kimchi-experimental": { type: "api_key", key: "kimchi-key" },
		})
		expect(statSync(authPath).mode & 0o777).toBe(0o600)
	})

	it("removes stale Kimchi credentials when the key is cleared", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				"kimchi-dev": { type: "api_key", key: "old" },
				"kimchi-experimental": { type: "api_key", key: "old" },
				ollama: { type: "api_key", key: "keep" },
			}),
		)
		writeFileSync(modelsPath, JSON.stringify({ providers: { "kimchi-dev": {} } }))

		await syncPiAuth(authPath, modelsPath, "")

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			ollama: { type: "api_key", key: "keep" },
		})
	})

	it("does not rewrite auth storage when Kimchi credentials are unchanged", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		const originalAuth = JSON.stringify({
			anthropic: { type: "api_key", key: "keep-me" },
			"kimchi-dev": { type: "api_key", key: "kimchi-key" },
		})
		writeFileSync(authPath, originalAuth)
		writeFileSync(modelsPath, JSON.stringify({ providers: { "kimchi-dev": {} } }))
		const fixedTime = new Date("2000-01-01T00:00:00.000Z")
		utimesSync(authPath, fixedTime, fixedTime)
		const originalMtime = statSync(authPath).mtimeMs

		await syncPiAuth(authPath, modelsPath, "kimchi-key")

		expect(readFileSync(authPath, "utf-8")).toBe(originalAuth)
		expect(statSync(authPath).mtimeMs).toBe(originalMtime)
		expect(statSync(authPath).mode & 0o777).toBe(0o600)
	})

	it("switches the active key in the same Pi runtime, including newly discovered sub-providers", async () => {
		vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-runtime-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", dir)
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				"kimchi-dev": { type: "api_key", key: "old-account-token" },
			}),
		)
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { "kimchi-dev": provider([model("old-model")]) },
			}),
		)

		const runtime = await ModelRuntime.create({
			authPath,
			modelsPath,
			allowModelNetwork: false,
			refreshOnCreate: false,
		})
		const registry = new ModelRegistry(runtime)
		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("old-account-token")

		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"kimchi-dev": provider([model("new-root-model")]),
					"kimchi-dev/new-provider": provider([model("new-sub-provider-model")]),
				},
			}),
		)
		await syncKimchiAuth(registry, "new-account-token")

		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("new-account-token")
		expect(await registry.getApiKeyForProvider("kimchi-dev/new-provider")).toBe("new-account-token")
		expect(new Set(registry.getAll().map(({ provider }) => provider))).toEqual(
			new Set(["kimchi-dev", "kimchi-dev/new-provider"]),
		)
	})

	it("rejects when a --api-key runtime override prevents Kimchi from activating the synchronized credential", async () => {
		vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-stale-runtime-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", dir)
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				"kimchi-dev": { type: "api_key", key: "old-account-token" },
			}),
		)
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { "kimchi-dev": provider([model("kimchi-model")]) },
			}),
		)

		const runtime = await ModelRuntime.create({
			authPath,
			modelsPath,
			allowModelNetwork: false,
			refreshOnCreate: false,
		})
		const registry = new ModelRegistry(runtime)
		await runtime.setRuntimeApiKey("kimchi-dev", "stale-runtime-token")

		await expect(syncKimchiAuth(registry, "new-account-token")).rejects.toThrow(
			"Kimchi did not activate the updated credentials for: kimchi-dev",
		)
		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toMatchObject({
			"kimchi-dev": { type: "api_key", key: "new-account-token" },
		})
		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stale-runtime-token")
	})
})
