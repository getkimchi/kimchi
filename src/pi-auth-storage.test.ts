import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Regression tests for the "Auth-storage lock-free reads" hunk in
 * patches/@earendil-works__pi-coding-agent@0.85.1.patch.
 *
 * The first AuthStorage read after an external auth.json revision change
 * (another kimchi process's syncPiAuth write or chmod — auth.json is shared
 * by all kimchi processes) must resolve the bare credential map. The hunk
 * originally returned the `{ result: data }` callback shape instead, so
 * `read(provider)` returned undefined and request auth fell back to
 * models.json's `$KIMCHI_API_KEY` — which kimchi strips from process.env at
 * startup — failing with `API key auth failed for provider kimchi-dev: Failed
 * to resolve API key ... from environment variable: KIMCHI_API_KEY`.
 *
 * The torn-read case drives the retry branch of the lock-free hunk: upstream
 * modify() is truncate-then-writeFileSync (non-atomic, but holding the
 * lock), so a lock-free read that observes a partial file retries with
 * backoff and observes the completed write.
 */

const tempDirs: string[] = []

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

function seedDir(dir: string): { authPath: string; modelsPath: string } {
	const authPath = join(dir, "auth.json")
	const modelsPath = join(dir, "models.json")
	writeFileSync(authPath, `${JSON.stringify({ "kimchi-dev": { type: "api_key", key: "stored-key" } }, null, 2)}\n`)
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				"kimchi-dev": {
					baseUrl: "https://example.invalid/openai/v1",
					apiKey: "$KIMCHI_API_KEY",
					api: "openai-completions",
					models: [],
				},
			},
		}),
	)
	return { authPath, modelsPath }
}

async function createRegistry(authPath: string, modelsPath: string): Promise<ModelRegistry> {
	const runtime = await ModelRuntime.create({
		authPath,
		modelsPath,
		allowModelNetwork: false,
		refreshOnCreate: false,
	})
	return new ModelRegistry(runtime)
}

const PARTIAL = '{ "kimchi-dev": { "type": "api_key", "key": "sto'

describe("AuthStorage reads after external auth.json mutation (pi patch regression)", () => {
	it("resolves the stored credential after another process rewrites auth.json", async () => {
		vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-auth-storage-patch-"))
		tempDirs.push(dir)
		const { authPath, modelsPath } = seedDir(dir)
		const registry = await createRegistry(authPath, modelsPath)

		// Another process rewrites auth.json with a different credential (the
		// shape kimchi syncPiAuth produces on key rotation).
		writeFileSync(authPath, `${JSON.stringify({ "kimchi-dev": { type: "api_key", key: "stored-key-2" } }, null, 2)}\n`)
		chmodSync(authPath, 0o600)

		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key-2")
	})

	it("resolves the stored credential after another process only touches auth.json metadata", async () => {
		vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-auth-storage-patch-"))
		tempDirs.push(dir)
		const { authPath, modelsPath } = seedDir(dir)
		const registry = await createRegistry(authPath, modelsPath)

		// Another process chmods auth.json (kimchi syncPiAuth does this on
		// every startup when the file mode is wrong). Only the revision
		// changes.
		chmodSync(authPath, 0o600)

		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key")
	})

	it("heals a transient torn read by retrying inside the backoff window", async () => {
		vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-auth-storage-patch-"))
		tempDirs.push(dir)
		const { authPath, modelsPath } = seedDir(dir)
		const registry = await createRegistry(authPath, modelsPath)
		// Establish a snapshot so the torn-read branch is exercised after an
		// external revision change.
		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key")

		// Simulate upstream modify()'s non-atomic truncate-then-write while
		// holding the lock: partial JSON with a fresh ctime revision, then
		// the completed write lands 5ms later, inside the first backoff
		// window. The lock-free read must retry and observe the healed value.
		writeFileSync(authPath, PARTIAL)
		chmodSync(authPath, 0o600)
		// Tracked so afterEach can cancel it before removing the temp dir.
		const repairTimer = setTimeout(() => {
			writeFileSync(
				authPath,
				`${JSON.stringify({ "kimchi-dev": { type: "api_key", key: "stored-key-2" } }, null, 2)}\n`,
			)
			chmodSync(authPath, 0o600)
		}, 5)
		try {
			expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key-2")
		} finally {
			clearTimeout(repairTimer)
		}
	})

	it("a persistently corrupt file resolves undefined on fresh storage, and repair is picked up immediately after", async () => {
		vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-auth-storage-patch-"))
		tempDirs.push(dir)
		const { authPath, modelsPath } = seedDir(dir)
		const registry = await createRegistry(authPath, modelsPath)
		// Establish a snapshot.
		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key")

		// Persistent corruption: upstream readLatestData() swallows the
		// reload failure and serves readState.data. `ModelRegistry` builds a
		// fresh `AuthStorage` per credential read, so `readState.data` is
		// always undefined here — there is no stale snapshot to hang on. The
		// request then falls back to $KIMCHI_API_KEY (stripped at startup)
		// and surfaces the provider credential error. That is the
		// "corrupt auth.json" failure mode users see; the retry logic
		// above does not rescue it because the failure never heals.
		writeFileSync(authPath, PARTIAL)
		chmodSync(authPath, 0o600)
		await expect(registry.getApiKeyForProvider("kimchi-dev")).resolves.toBeUndefined()

		// A repaired file is picked up on the very next read: the failed
		// attempt did NOT cache the bad state (the read-state revision is
		// left stale, so the next call re-arms the reload).
		writeFileSync(authPath, `${JSON.stringify({ "kimchi-dev": { type: "api_key", key: "stored-key-2" } }, null, 2)}\n`)
		chmodSync(authPath, 0o600)
		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key-2")
	})

	it("a persistently corrupt file on fresh storage resolves undefined without stale state", async () => {
		vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-auth-storage-patch-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		// auth.json is corrupt from the start; no snapshot exists anywhere.
		writeFileSync(authPath, PARTIAL)
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"kimchi-dev": {
						baseUrl: "https://example.invalid/openai/v1",
						apiKey: "$KIMCHI_API_KEY",
						api: "openai-completions",
						models: [],
					},
				},
			}),
		)
		const registry = await createRegistry(authPath, modelsPath)

		// Same upstream swallow: no snapshot to serve, so resolve returns
		// undefined and the request surfaces the credential-store error
		// instead of silently keeping a stale credential.
		await expect(registry.getApiKeyForProvider("kimchi-dev")).resolves.toBeUndefined()
	})
})
