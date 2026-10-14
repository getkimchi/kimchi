import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { debugWorkAttribution } from "./diagnostics.js"

let directory: string
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-attribution-diagnostics-"))
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
	{ setting: "kimchi:work-attribution", enabled: true },
	{ setting: "http,KIMCHI:*", enabled: true },
])("keeps diagnostics off the terminal (NODE_DEBUG=$setting)", ({ setting, enabled }) => {
	vi.stubEnv("NODE_DEBUG", setting)
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
	debugWorkAttribution("Could not read %s: %o", "trace", new Error("storage unavailable"))
	debugWorkAttribution("Next diagnostic")
	expect(stdout).not.toHaveBeenCalled()
	expect(stderr).not.toHaveBeenCalled()
	const log = join(directory, "logs", "work-attribution.log")
	expect(existsSync(log)).toBe(enabled)
	if (enabled) {
		const content = readFileSync(log, "utf8")
		expect(content).toContain("Could not read trace: Error: storage unavailable")
		expect(content).toContain("Next diagnostic")
		expect(statSync(log).mode & 0o777).toBe(0o600)
		expect(statSync(join(directory, "logs")).mode & 0o777).toBe(0o700)
	}
})

it("does not interrupt execution or print when the log cannot be written", () => {
	vi.stubEnv("NODE_DEBUG", "kimchi:work-attribution")
	writeFileSync(join(directory, "logs"), "blocked")
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
	expect(() => debugWorkAttribution("Original failure", new Error("no space"))).not.toThrow()
	expect(stderr).not.toHaveBeenCalled()
})
