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

	it("leaves the ChatGPT subscription login alone when storing or clearing the Kimchi key", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		const chatgpt = { type: "oauth", access: "chatgpt-jwt", refresh: "", expires: 4_102_444_800_000 }
		writeFileSync(authPath, JSON.stringify({ "kimchi-dev/openai-codex": chatgpt }))
		writeFileSync(modelsPath, JSON.stringify({ providers: { "kimchi-dev": {}, "kimchi-dev/openai-codex": {} } }))

		await syncPiAuth(authPath, modelsPath, "kimchi-key")
		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			"kimchi-dev": { type: "api_key", key: "kimchi-key" },
			"kimchi-dev/openai-codex": chatgpt,
		})

		await syncPiAuth(authPath, modelsPath, "")
		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({ "kimchi-dev/openai-codex": chatgpt })
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
		// Listen before the writes: on a slow runner the 60 writes can outlast the
		// reader, and an exit event with no listener left this test hanging.
		// "close" (not "exit") also waits until all stdout has been read.
		const result = new Promise<{ reads: number; bad: number }>((resolve, reject) => {
			let out = ""
			reader.stdout?.on("data", (chunk) => (out += chunk))
			reader.on("close", () => {
				try {
					resolve(JSON.parse(out.trim()))
				} catch (error) {
					reject(error)
				}
			})
			reader.on("error", reject)
		})

		for (let i = 0; i < 60; i++) {
			await syncPiAuth(authPath, modelsPath, `key-${i}`)
		}

		const { reads, bad } = await result

		expect(reads).toBeGreaterThan(0)
		expect(bad).toBe(0)
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

describe("syncOAuthCredentialToKimchiProviders guarded fan-out", () => {
	const newerCredential = {
		...oauthCredential,
		access: "id-2",
		refresh: "rt-2",
		expires: oauthCredential.expires + 60_000,
	}

	/**
	 * Deterministic interleaving: the store is changed to the winning state
	 * before sync is invoked, and the pre-call auth.json mtime is pushed into
	 * the past so any guarded write would be observable (existing pattern from
	 * the no-op sync tests).
	 */
	function setupStore(authEntries: Record<string, unknown>, modelsProviders: Record<string, unknown> | null) {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-oauth-guard-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		writeFileSync(authPath, `${JSON.stringify(authEntries, null, 2)}\n`, { mode: 0o600 })
		if (modelsProviders) writeFileSync(modelsPath, JSON.stringify({ providers: modelsProviders }))
		const fixedTime = new Date(Date.now() - 60_000)
		utimesSync(authPath, fixedTime, fixedTime)
		return { authPath, modelsPath, mtime: statSync(authPath).mtimeMs }
	}

	it("does not resurrect a superseded credential: the newer login wins and no write occurs", async () => {
		const { authPath, modelsPath, mtime } = setupStore(
			{ "kimchi-dev": newerCredential, "kimchi-dev/openai": newerCredential },
			{ "kimchi-dev": {}, "kimchi-dev/openai": {} },
		)
		const original = readFileSync(authPath, "utf-8")

		await syncOAuthCredentialToKimchiProviders(authPath, modelsPath, oauthCredential, undefined, {
			expectedCanonical: oauthCredential,
		})

		// The attempted fan-out of snapshot A lost to the newer credential B:
		// concrete entries keep B and auth.json was not written at all.
		expect(readFileSync(authPath, "utf-8")).toBe(original)
		expect(statSync(authPath).mtimeMs).toBe(mtime)
	})

	it("does not recreate the canonical credential after an interleaved logout", async () => {
		const { authPath, modelsPath, mtime } = setupStore({}, { "kimchi-dev": {}, "kimchi-dev/openai": {} })

		await syncOAuthCredentialToKimchiProviders(authPath, modelsPath, oauthCredential, undefined, {
			expectedCanonical: oauthCredential,
		})

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({})
		expect(statSync(authPath).mtimeMs).toBe(mtime)
	})

	it("still fans out when the canonical matches, ignoring unrelated metadata", async () => {
		const { authPath, modelsPath, mtime } = setupStore(
			{
				// Same access/refresh/expires identity as the expected snapshot,
				// different unrelated metadata.
				"kimchi-dev": { ...oauthCredential, region: "eu", note: "metadata" },
				"kimchi-dev/openai": { ...oauthCredential, access: "stale-bearer" },
			},
			{ "kimchi-dev": {}, "kimchi-dev/openai": {} },
		)

		await syncOAuthCredentialToKimchiProviders(authPath, modelsPath, oauthCredential, undefined, {
			expectedCanonical: oauthCredential,
		})

		const credentials = JSON.parse(readFileSync(authPath, "utf-8"))
		expect(credentials["kimchi-dev"]).toEqual(oauthCredential)
		expect(credentials["kimchi-dev/openai"]).toEqual(oauthCredential)
		expect(statSync(authPath).mtimeMs).toBeGreaterThan(mtime)
	})

	it("treats access, refresh, and expires each as credential identity", async () => {
		for (const field of ["access", "refresh", "expires"] as const) {
			const divergent = field === "expires" ? oauthCredential.expires + 1 : `different-${field}`
			const { authPath, modelsPath, mtime } = setupStore(
				{ "kimchi-dev": { ...oauthCredential, [field]: divergent } },
				{ "kimchi-dev": {} },
			)
			const original = readFileSync(authPath, "utf-8")

			await syncOAuthCredentialToKimchiProviders(authPath, modelsPath, oauthCredential, undefined, {
				expectedCanonical: oauthCredential,
			})

			expect(readFileSync(authPath, "utf-8"), `field: ${field}`).toBe(original)
			expect(statSync(authPath).mtimeMs, `field: ${field}`).toBe(mtime)
		}
	})

	it("returns before malformed models.json can throw on a losing guard", async () => {
		const { authPath, modelsPath, mtime } = setupStore({ "kimchi-dev": newerCredential }, null)
		writeFileSync(modelsPath, "{ not json")
		const original = readFileSync(authPath, "utf-8")

		// The guard rejects the stale snapshot before models.json is ever read.
		await expect(
			syncOAuthCredentialToKimchiProviders(authPath, modelsPath, oauthCredential, undefined, {
				expectedCanonical: oauthCredential,
			}),
		).resolves.toBeUndefined()
		expect(readFileSync(authPath, "utf-8")).toBe(original)
		expect(statSync(authPath).mtimeMs).toBe(mtime)

		// Unguarded callers keep the existing propagation for the same store.
		await expect(syncOAuthCredentialToKimchiProviders(authPath, modelsPath, oauthCredential)).rejects.toThrow()
	})
})
