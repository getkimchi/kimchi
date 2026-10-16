import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { debugPRCost } from "./pr-cost-log.js"

let directory: string
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-pr-cost-log-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", directory)
	vi.stubEnv("NODE_DEBUG", "")
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})

it.each([
	{ setting: "", enabled: false },
	{ setting: "http", enabled: false },
	{ setting: "kimchi:pr-cost", enabled: true },
	{ setting: "http,KIMCHI:*", enabled: true },
])("keeps diagnostics off the terminal (NODE_DEBUG=$setting)", ({ setting, enabled }) => {
	vi.stubEnv("NODE_DEBUG", setting)
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
	debugPRCost("Could not retain %s: %o", "plan", new Error("storage unavailable"))
	debugPRCost("Next diagnostic")
	expect(stdout).not.toHaveBeenCalled()
	expect(stderr).not.toHaveBeenCalled()
	const log = join(directory, "logs", "pr-cost.log")
	expect(existsSync(log)).toBe(enabled)
	if (enabled) {
		const content = readFileSync(log, "utf8")
		expect(content).toContain("Could not retain plan: Error: storage unavailable")
		expect(content).toContain("Next diagnostic")
		expect(statSync(log).mode & 0o777).toBe(0o600)
		expect(statSync(join(directory, "logs")).mode & 0o777).toBe(0o700)
	}
})

it("does not interrupt execution or print when the log cannot be written", () => {
	vi.stubEnv("NODE_DEBUG", "kimchi:pr-cost")
	writeFileSync(join(directory, "logs"), "blocked")
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
	expect(() => debugPRCost("Original failure", new Error("no space"))).not.toThrow()
	expect(stderr).not.toHaveBeenCalled()
})
