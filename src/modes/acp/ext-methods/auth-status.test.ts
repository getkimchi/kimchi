import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearApiKey, writeApiKey } from "../../../config.js"
import { type AuthStatusPaths, handleAuthStatus } from "./auth-status.js"

// Integration-style handler tests against the real credential store:
// config.json (API key) and auth.json (OAuth credentials) on real temp
// files — no config.js mocks — so the persist→read linkage is exercised.
describe("handleAuthStatus", () => {
	let dir: string
	let configPath: string
	let paths: AuthStatusPaths

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-auth-status-"))
		configPath = join(dir, "config.json")
		paths = {
			authPath: join(dir, "auth.json"),
			modelsPath: join(dir, "models.json"),
			configPath,
		}
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it("reports unauthenticated when neither store holds credentials", async () => {
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })
	})

	it("reports authenticated when config.json holds an API key", async () => {
		writeApiKey("castai_v1_token", configPath)
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: true })
	})

	it("reports unauthenticated again after the API key is cleared", async () => {
		writeApiKey("castai_v1_token", configPath)
		clearApiKey(configPath)
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })
	})

	// Regression: the subscription OAuth login persists credentials only to
	// auth.json — it never writes config.json's apiKey — so an auth check
	// that reads only the config file reports authenticated: false for a
	// logged-in user. Seed the canonical OAuth credential shape
	// ({ type: "oauth", access, refresh, expires }) — malformed entries are
	// dropped by the credential reader.
	it("reports authenticated when only auth.json holds OAuth credentials", async () => {
		writeFileSync(
			paths.authPath,
			JSON.stringify({
				"kimchi-dev": { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3600_000 },
			}),
		)
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: true })
	})
})
