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
 * The torn-read case covers writers' truncate-then-writeFileSync (not
 * atomic): a lock-free read that observes a partial file keeps the last valid
 * snapshot instead of surfacing a JSON parse error at request time.
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

describe("AuthStorage reads after external auth.json mutation (pi patch regression)", () => {
	it("resolves the stored credential after another process rewrites auth.json", async () => {
		vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-auth-storage-patch-"))
		tempDirs.push(dir)
		const { authPath, modelsPath } = seedDir(dir)
		const registry = await createRegistry(authPath, modelsPath)
		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key")

		// Another kimchi process rewrites the shared auth.json (syncPiAuth's
		// content-write path): fresh mtime/ctime revision, same key.
		writeFileSync(authPath, `${JSON.stringify({ "kimchi-dev": { type: "api_key", key: "stored-key" } }, null, 2)}\n`)

		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key")
	})

	it("resolves the stored credential after another process only touches auth.json metadata", async () => {
		vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-auth-storage-patch-"))
		tempDirs.push(dir)
		const { authPath, modelsPath } = seedDir(dir)
		const registry = await createRegistry(authPath, modelsPath)
		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key")

		// External ctime-only bump (what syncPiAuth's unconditional chmod did
		// at every startup before the stat-gated skip in src/pi-auth.ts).
		chmodSync(authPath, 0o600)

		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key")
	})

	it("keeps the last valid snapshot when a lock-free read observes a torn write", async () => {
		vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		const dir = mkdtempSync(join(tmpdir(), "kimchi-auth-storage-patch-"))
		tempDirs.push(dir)
		const { authPath, modelsPath } = seedDir(dir)
		const registry = await createRegistry(authPath, modelsPath)
		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key")

		// Simulate the window of a non-atomic truncate-then-writeFileSync:
		// partial JSON on disk plus a fresh ctime revision. Without torn-read
		// tolerance in the lock-free branch, the raw parse error propagates.
		writeFileSync(authPath, '{ "kimchi-dev": { "type": "api_key", "key": "sto')
		chmodSync(authPath, 0o600)
		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key")

		// A completed write re-arms the reload and the new value wins.
		writeFileSync(authPath, `${JSON.stringify({ "kimchi-dev": { type: "api_key", key: "stored-key-2" } }, null, 2)}\n`)
		expect(await registry.getApiKeyForProvider("kimchi-dev")).toBe("stored-key-2")
	})
})
