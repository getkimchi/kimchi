import { spawn } from "node:child_process"
import {
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { syncKimchiAuth } from "./extensions/login/flow.js"
import { clearPiAuth, syncOAuthCredentialToKimchiProviders, syncPiAuth } from "./pi-auth.js"

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

	it("writes auth.json atomically so a concurrent lock-free reader never observes a torn file", async () => {
		// POSIX rename is the invariant under test; Windows replace semantics differ.
		if (process.platform === "win32") return
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-atomic-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")

		// Large payload widens the write window; readers skip the write lock.
		const providers: Record<string, unknown> = {}
		for (let i = 0; i < 3000; i++) providers[`kimchi-dev/upstream-${i.toString().padStart(4, "0")}`] = {}
		writeFileSync(modelsPath, JSON.stringify({ providers }))

		await syncPiAuth(authPath, modelsPath, "seed-key")

		const reader = spawn(
			process.execPath,
			[
				"-e",
				`const fs = require("node:fs");
const path = process.argv[1];
const deadline = Date.now() + Number(process.argv[2]);
let reads = 0, bad = 0;
while (Date.now() < deadline) {
	let raw;
	try { raw = fs.readFileSync(path, "utf-8"); } catch { bad++; continue; }
	reads++;
	try { JSON.parse(raw); } catch { bad++; }
}
process.stdout.write(JSON.stringify({ reads, bad }));`,
				authPath,
				"4000",
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		)

		for (let i = 0; i < 60; i++) {
			await syncPiAuth(authPath, modelsPath, `key-${i}`)
		}

		const result = await new Promise<{ reads: number; bad: number }>((resolve, reject) => {
			let out = ""
			reader.stdout?.on("data", (chunk) => (out += chunk))
			reader.on("exit", () => {
				try {
					resolve(JSON.parse(out.trim()))
				} catch (error) {
					reject(error)
				}
			})
			reader.on("error", reject)
		})

		expect(result.reads).toBeGreaterThan(0)
		expect(result.bad).toBe(0)
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([])
	}, 30_000)

	it("preserves a symlinked auth.json when rewriting credentials", async () => {
		if (process.platform === "win32") return // POSIX-only
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-symlink-"))
		const otherDir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-symlink-target-"))
		tempDirs.push(dir, otherDir)
		const authPath = join(dir, "auth.json")
		const realPath = join(otherDir, "real-auth.json")
		const modelsPath = join(dir, "models.json")

		writeFileSync(realPath, JSON.stringify({ "kimchi-dev": { type: "api_key", key: "old-key" } }), { mode: 0o600 })
		writeFileSync(modelsPath, JSON.stringify({ providers: { "kimchi-dev": {} } }))
		symlinkSync(realPath, authPath)

		await syncPiAuth(authPath, modelsPath, "rotated-key")

		expect(lstatSync(authPath).isSymbolicLink()).toBe(true)
		expect(JSON.parse(readFileSync(realPath, "utf-8"))).toEqual({
			"kimchi-dev": { type: "api_key", key: "rotated-key" },
		})
		expect(statSync(realPath).mode & 0o777).toBe(0o600)
		expect(
			readdirSync(dir)
				.concat(readdirSync(otherDir))
				.filter((f) => f.endsWith(".tmp")),
		).toEqual([])
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

	it("does not touch auth storage metadata when credentials and mode are unchanged", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		const originalAuth = JSON.stringify({
			anthropic: { type: "api_key", key: "keep-me" },
			"kimchi-dev": { type: "api_key", key: "kimchi-key" },
		})
		writeFileSync(authPath, originalAuth, { mode: 0o600 })
		writeFileSync(modelsPath, JSON.stringify({ providers: { "kimchi-dev": {} } }))
		const before = statSync(authPath, { bigint: true })

		await syncPiAuth(authPath, modelsPath, "kimchi-key")

		const after = statSync(authPath, { bigint: true })
		// No chmod on the no-op path: auth.json is shared by all kimchi processes
		// and an unconditional chmod bumps its ctime, forcing every other running
		// session to re-read the file (their revision check includes ctime).
		expect(after.ctimeNs).toBe(before.ctimeNs)
		expect(after.mtimeNs).toBe(before.mtimeNs)
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

describe("clearPiAuth", () => {
	it("removes every Kimchi credential, keeps other providers, and needs no models.json", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				"kimchi-dev": { type: "api_key", key: "old" },
				"kimchi-dev/anthropic": { type: "api_key", key: "old" },
				"kimchi-experimental": { type: "api_key", key: "old" },
				anthropic: { type: "api_key", key: "keep" },
			}),
		)

		await clearPiAuth(authPath)

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			anthropic: { type: "api_key", key: "keep" },
		})
	})

	it("is a no-op when auth.json does not exist", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")

		await expect(clearPiAuth(authPath)).resolves.toBeUndefined()
	})
})

describe("syncOAuthCredentialToKimchiProviders", () => {
	const oauthCredential = {
		type: "oauth",
		access: "id-1",
		refresh: "rt-1",
		expires: Date.now() + 3600_000,
		region: "us",
		tokenUrl: "https://login.kimchi.dev/oauth/token",
		clientId: "kimchi-cli-us",
		useIdToken: true,
	}

	it("fans the OAuth credential out to every Kimchi-managed provider, replacing stale entries", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-oauth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				anthropic: { type: "api_key", key: "keep-me" },
				"kimchi-dev": { type: "api_key", key: "stale-key" },
				"kimchi-dev/openai": { type: "api_key", key: "stale-key" },
			}),
		)
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { "kimchi-dev": {}, "kimchi-dev/openai": {}, "kimchi-experimental": {}, ollama: {} },
			}),
		)

		await syncOAuthCredentialToKimchiProviders(authPath, modelsPath, oauthCredential)

		const credentials = JSON.parse(readFileSync(authPath, "utf-8"))
		expect(credentials.anthropic).toEqual({ type: "api_key", key: "keep-me" })
		expect(credentials.ollama).toBeUndefined()
		for (const providerId of ["kimchi-dev", "kimchi-dev/openai", "kimchi-experimental"]) {
			expect(credentials[providerId]).toEqual(oauthCredential)
		}
		expect(statSync(authPath).mode & 0o777).toBe(0o600)
	})

	it("always includes the base kimchi-dev provider even without models.json", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-oauth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")

		await syncOAuthCredentialToKimchiProviders(authPath, modelsPath, oauthCredential)

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({ "kimchi-dev": oauthCredential })
	})

	it("is a no-op when the credential is already fanned out", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-oauth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		writeFileSync(modelsPath, JSON.stringify({ providers: { "kimchi-dev": {} } }))

		await syncOAuthCredentialToKimchiProviders(authPath, modelsPath, oauthCredential)
		const first = statSync(authPath).mtimeMs
		// Push mtime into the past so a rewrite would be observable.
		utimesSync(authPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))

		await syncOAuthCredentialToKimchiProviders(authPath, modelsPath, oauthCredential)
		expect(statSync(authPath).mtimeMs).toBeLessThan(first)
	})
})
