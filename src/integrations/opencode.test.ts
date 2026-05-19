import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TEST_MODELS } from "./__fixtures__/models.js"
import "../integrations/opencode.js"
import { byId } from "./registry.js"

describe("opencode tool registration", () => {
	let scratchHome: string
	let prevHome: string | undefined

	beforeEach(() => {
		scratchHome = mkdtempSync(join(tmpdir(), "kimchi-opencode-test-"))
		prevHome = process.env.HOME
		process.env.HOME = scratchHome
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		rmSync(scratchHome, { recursive: true, force: true })
	})

	it("registers itself with the integrations registry on import", () => {
		const tool = byId("opencode")
		expect(tool).toBeDefined()
		expect(tool?.binaryName).toBe("opencode")
		expect(tool?.configPath).toBe("~/.config/opencode/opencode.json")
	})

	it("write() rejects an empty API key", async () => {
		const tool = byId("opencode")
		await expect(tool?.write("global", "", TEST_MODELS)).rejects.toThrow(/API key/)
	})

	it("write() merges provider config into opencode.json without clobbering unrelated keys", async () => {
		const path = `${scratchHome}/.config/opencode/opencode.json`
		mkdirSync(`${scratchHome}/.config/opencode`, { recursive: true })
		writeFileSync(path, JSON.stringify({ theme: "dark", provider: { other: { keep: true } } }), "utf-8")

		const tool = byId("opencode")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const written = JSON.parse(readFileSync(path, "utf-8"))
		expect(written.theme).toBe("dark")
		expect(written.$schema).toBe("https://opencode.ai/config.json")
		expect(written.provider.other).toEqual({ keep: true })
		expect(written.provider.kimchi).toBeDefined()
		expect((written.provider.kimchi as { options: { apiKey: string } }).options.apiKey).toBe("test-key-123")
		expect(written.model).toBe("kimchi/kimi-k2.6")
		expect(written.compaction).toEqual({ auto: true })
	})

	it("write() removes stale plugin field from prior @kimchi-dev/opencode-kimchi installs", async () => {
		const path = `${scratchHome}/.config/opencode/opencode.json`
		mkdirSync(`${scratchHome}/.config/opencode`, { recursive: true })
		writeFileSync(
			path,
			JSON.stringify({
				$schema: "https://opencode.ai/config.json",
				plugin: ["@kimchi-dev/opencode-kimchi@1.14.0"],
				provider: { kimchi: { options: { apiKey: "old" } } },
			}),
			"utf-8",
		)

		const tool = byId("opencode")
		await tool?.write("global", "test-key-123", TEST_MODELS)

		const written = JSON.parse(readFileSync(path, "utf-8"))
		expect(written.plugin).toBeUndefined()
		expect(written.provider.kimchi).toBeDefined()
	})
})
