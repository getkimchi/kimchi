import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))
vi.mock("../env.js", () => ({ isBunBinary: true, isRunningUnderBun: false }))

let homeDir: string

beforeEach(() => {
	homeDir = mkdtempSync(join(tmpdir(), "kimchi-subprocess-auth-"))
	vi.stubEnv("HOME", homeDir)
	vi.stubEnv("KIMCHI_API_KEY", undefined)
	vi.spyOn(process, "cwd").mockReturnValue(homeDir)
	vi.resetModules()
	vi.mocked(spawn).mockClear()
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	rmSync(homeDir, { recursive: true, force: true })
})

it.each([
	{ scenario: "environment-only login", environmentKey: "environment-key", savedKey: undefined },
	{ scenario: "environment overriding a saved login", environmentKey: "environment-key", savedKey: "saved-key" },
	{ scenario: "saved login", environmentKey: undefined, savedKey: "saved-key" },
])("forwards the effective credential for $scenario without restoring the parent environment", async ({
	environmentKey,
	savedKey,
}) => {
	const configPath = join(homeDir, ".config", "kimchi", "config.json")
	const originalConfig = JSON.stringify({ apiKey: savedKey })
	if (savedKey) {
		mkdirSync(join(homeDir, ".config", "kimchi"), { recursive: true })
		writeFileSync(configPath, originalConfig, { mode: 0o600 })
	}
	vi.stubEnv("KIMCHI_API_KEY", environmentKey)
	const { captureApiKeyFromEnvironment } = await import("../config.js")
	captureApiKeyFromEnvironment()
	expect(process.env.KIMCHI_API_KEY).toBeUndefined()
	const { spawnKimchiSubprocess } = await import("./spawn-kimchi-subprocess.js")
	spawnKimchiSubprocess({ args: ["--print", "review"], env: { KIMCHI_SESSION_REVIEW: "1" } })
	expect(spawn).toHaveBeenCalledWith(
		process.execPath,
		["--print", "review"],
		expect.objectContaining({
			env: expect.objectContaining({ KIMCHI_API_KEY: environmentKey ?? savedKey, KIMCHI_SESSION_REVIEW: "1" }),
		}),
	)
	expect(process.env.KIMCHI_API_KEY).toBeUndefined()
	if (savedKey) expect(readFileSync(configPath, "utf-8")).toBe(originalConfig)
	else expect(existsSync(configPath)).toBe(false)
})
