import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

let homeDir: string
let configPath: string

beforeEach(() => {
	homeDir = mkdtempSync(join(tmpdir(), "kimchi-web-search-auth-"))
	configPath = join(homeDir, ".config", "kimchi", "config.json")
	vi.stubEnv("HOME", homeDir)
	vi.stubEnv("KIMCHI_API_KEY", undefined)
	vi.spyOn(process, "cwd").mockReturnValue(homeDir)
	// Reload config's launch-time state and paths for each isolated process scenario.
	vi.resetModules()
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation(async () => Response.json({ sources: [] })),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	rmSync(homeDir, { recursive: true, force: true })
})

it.each([
	{ scenario: "environment-only login", environmentKey: "environment-key", savedKey: undefined },
	{ scenario: "environment override of a saved login", environmentKey: "environment-key", savedKey: "saved-key" },
	{ scenario: "saved login without an override", environmentKey: undefined, savedKey: "saved-key" },
])("authenticates web search after startup with $scenario", async ({ environmentKey, savedKey }) => {
	const originalConfig = JSON.stringify({ apiKey: savedKey })
	if (savedKey) {
		mkdirSync(join(homeDir, ".config", "kimchi"), { recursive: true })
		writeFileSync(configPath, originalConfig, { mode: 0o600 })
	}
	vi.stubEnv("KIMCHI_API_KEY", environmentKey)
	const { captureApiKeyFromEnvironment } = await import("../../config.js")
	captureApiKeyFromEnvironment()
	expect(process.env.KIMCHI_API_KEY).toBeUndefined()

	const { executeWebSearch, SEARCH_ENDPOINT } = await import("./execute-handler.js")
	await executeWebSearch({ query: "test" })

	expect(fetch).toHaveBeenCalledWith(
		SEARCH_ENDPOINT,
		expect.objectContaining({
			headers: expect.objectContaining({ Authorization: `Bearer ${environmentKey ?? savedKey}` }),
		}),
	)
	expect(process.env.KIMCHI_API_KEY).toBeUndefined()
	if (savedKey) expect(readFileSync(configPath, "utf-8")).toBe(originalConfig)
	else expect(existsSync(configPath)).toBe(false)
})
