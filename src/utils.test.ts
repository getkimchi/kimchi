import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

describe("getVersion", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("returns 'dev' when package.json has 0.0.0 and no PI_PACKAGE_DIR", async () => {
		// Ensure PI_PACKAGE_DIR is not set so getVersion falls back to workspace package.json
		vi.stubEnv("PI_PACKAGE_DIR", "")
		const { getVersion } = await import("./utils.js")
		const v = getVersion()
		expect(v).toBe("dev")
	})

	it("returns the real version from PI_PACKAGE_DIR package.json", async () => {
		const tmpDir = mkdtempSync(resolve(tmpdir(), "kimchi-test-"))
		writeFileSync(resolve(tmpDir, "package.json"), JSON.stringify({ name: "kimchi-test", version: "1.2.3" }))
		vi.stubEnv("PI_PACKAGE_DIR", tmpDir)
		const { getVersion } = await import("./utils.js")
		const v = getVersion()
		expect(v).toBe("1.2.3")
	})

	it("memoizes the result (returns the same value on repeated calls)", async () => {
		const { getVersion } = await import("./utils.js")
		const v1 = getVersion()
		const v2 = getVersion()
		expect(v1).toBe(v2)
	})
})
