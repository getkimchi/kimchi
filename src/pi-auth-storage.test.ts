import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Regression tests for the "Auth-storage lock-free reads" hunk in
 * patches/@earendil-works__pi-coding-agent@0.85.1.patch.
 *
 * After an external auth.json revision change (another process's syncPiAuth
 * write or chmod), read(provider) must resolve the bare credential map — the
 * hunk originally returned the callback's `{ result }` shape, so the first
 * read resolved undefined and request auth fell back to models.json's
 * $KIMCHI_API_KEY (stripped from process.env at startup): "API key auth
 * failed for provider kimchi-dev". Torn reads (upstream modify() is
 * non-atomic truncate-then-write) must retry inside the backoff window.
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

		// Another process rewrites auth.json with a rotated credential.
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

		// Another process chmods auth.json; only the revision changes.
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

		// Simulate upstream modify(): partial file with a fresh revision,
		// healed 5ms later — inside the first 10ms backoff — so the read must
		// observe the repaired value. Timer tracked so afterEach can cancel it.
		writeFileSync(authPath, PARTIAL)
		chmodSync(authPath, 0o600)
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

	it("heals a 0-byte tear (truncate window) by retrying instead of resolving empty credentials", async () => {
		vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-auth-storage-patch-"))
		tempDirs.push(dir)
		const { authPath, modelsPath } = seedDir(dir)
		const registry = await createRegistry(authPath, modelsPath)
		// Establish a snapshot so the torn-read branch is exercised after an
		// external revision change.
		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key")

		// Truncate auth.json to 0 bytes — the window between a non-atomic
		// writer's open(O_TRUNC) and its first write. parseStorageData() maps
		// empty content to {} WITHOUT throwing, so without the hunk the read
		// would silently resolve "no credentials" (request auth then falls
		// back to models.json's $KIMCHI_API_KEY and fails). The read must
		// treat the empty file as a tear and retry inside the backoff window.
		writeFileSync(authPath, "")
		chmodSync(authPath, 0o600)
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

		// Persistent corruption resolves undefined: upstream readLatestData()
		// swallows the reload failure, and ModelRegistry builds a fresh
		// AuthStorage per read (no stale snapshot). Retry cannot heal — the
		// failure never goes away inside the window.
		writeFileSync(authPath, PARTIAL)
		chmodSync(authPath, 0o600)
		await expect(registry.getApiKeyForProvider("kimchi-dev")).resolves.toBeUndefined()

		// No bad state is cached (revision left stale), so the next read
		// picks the repair up immediately.
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

		// Fresh storage, no snapshot: same undefined, no stale credential.
		await expect(registry.getApiKeyForProvider("kimchi-dev")).resolves.toBeUndefined()
	})
})
