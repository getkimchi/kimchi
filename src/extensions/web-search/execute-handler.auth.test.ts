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
	vi.stubEnv("KIMCHI_REGION", undefined)
	// Isolate from the ambient agent dir — a developer shell's real auth.json
	// is a credential source for keyless scenarios now.
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", join(homeDir, "agent"))
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

it("authenticates web search with an SSO login (auth.json OAuth credential + organization header)", async () => {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR as string
	mkdirSync(agentDir, { recursive: true })
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({ "kimchi-dev": { type: "oauth", access: "oauth-access", refresh: "r", orgId: "org-1" } }),
	)

	const { executeWebSearch } = await import("./execute-handler.js")
	await executeWebSearch({ query: "test" })

	expect(fetch).toHaveBeenCalledWith(
		"https://llm.kimchi.dev/v1/search",
		expect.objectContaining({
			headers: expect.objectContaining({
				Authorization: "Bearer oauth-access",
				"X-CastAi-Organization-Id": "org-1",
			}),
		}),
	)
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

	const { executeWebSearch } = await import("./execute-handler.js")
	await executeWebSearch({ query: "test" })

	expect(fetch).toHaveBeenCalledWith(
		"https://llm.kimchi.dev/v1/search",
		expect.objectContaining({
			headers: expect.objectContaining({ Authorization: `Bearer ${environmentKey ?? savedKey}` }),
		}),
	)
	expect(process.env.KIMCHI_API_KEY).toBeUndefined()
	if (savedKey) expect(readFileSync(configPath, "utf-8")).toBe(originalConfig)
	else expect(existsSync(configPath)).toBe(false)
})
