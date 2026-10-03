import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ENV_VARS, IGNORED_ENV_VARS, TEST_SUITE_ENV_VARS } from "../env-vars.js"
import { runEnv } from "./env.js"

describe("runEnv", () => {
	let logs: string[]

	beforeEach(() => {
		logs = []
		vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
			logs.push(String(msg))
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it("exits 0 and prints every user-facing variable with its description", async () => {
		expect(await runEnv([])).toBe(0)
		const output = logs.join("\n")
		for (const def of ENV_VARS) {
			expect(output, `missing ${def.name}`).toContain(def.name)
			expect(output, `missing description for ${def.name}`).toContain(def.description)
		}
	})

	it("never prints internal/dev variables", async () => {
		await runEnv([])
		const output = logs.join("\n")
		for (const name of [...IGNORED_ENV_VARS, ...TEST_SUITE_ENV_VARS]) {
			expect(output, `${name} should stay hidden`).not.toContain(name)
		}
	})

	it("masks secret values and prints non-secret ones", async () => {
		vi.stubEnv("KIMCHI_API_KEY", "super-secret-key")
		vi.stubEnv("KIMCHI_REGION", "eu")
		await runEnv([])
		const output = logs.join("\n")
		expect(output).not.toContain("super-secret-key")
		expect(output).toContain("set: ****")
		expect(output).toContain("set: eu")
	})

	it("marks unset variables as not set", async () => {
		vi.stubEnv("KIMCHI_REGION", "")
		vi.unstubAllEnvs()
		delete process.env.KIMCHI_REGION
		await runEnv([])
		expect(logs.join("\n")).toContain("(not set)")
	})

	it("treats an explicitly empty value as not set — never as a masked secret", async () => {
		vi.stubEnv("KIMCHI_API_KEY", "")
		await runEnv([])
		const nameIdx = logs.findIndex((l) => l.includes("KIMCHI_API_KEY"))
		expect(nameIdx).toBeGreaterThanOrEqual(0)
		const valueLine = logs.slice(nameIdx, nameIdx + 2).join("\n")
		expect(valueLine).toContain("(not set)")
		expect(valueLine).not.toContain("set: ****")
	})

	it("prints usage on --help without the variable list", async () => {
		expect(await runEnv(["--help"])).toBe(0)
		const output = logs.join("\n")
		expect(output).toContain("Usage: kimchi env")
		expect(output).not.toContain("KIMCHI_API_KEY")
	})
})
