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
		// Descriptions wrap at the terminal width — flatten wrapped lines before
		// asserting on the full description text.
		const flattened = output.replace(/\s*\n\s*/g, " ")
		for (const def of ENV_VARS) {
			expect(output, `missing ${def.name}`).toContain(def.name)
			expect(flattened, `missing description for ${def.name}`).toContain(def.description)
		}
	})

	it("aligns wrapped description continuations with the description column", async () => {
		await runEnv(["--values"])
		const descCol = 2 + Math.max(...ENV_VARS.map((v) => v.name.length)) + 2
		for (const line of logs) {
			// Bare console.log() calls land in the mock as "undefined"; the
			// header sits at column 0. Only entry and continuation rows matter.
			if (!line.trim() || line === "undefined" || line.includes("Environment variables recognised")) continue
			const indent = line.length - line.trimStart().length
			// Each output row is either an entry (variable name, indent 2) or a
			// wrapped description / value line aligned to the description column.
			expect([2, descCol], `line "${line.trim().slice(0, 40)}"`).toContain(indent)
		}
	})

	/** Value line of a registry entry — skips wrapped description lines. */
	function valueLineFor(name: string): string {
		const nameIdx = logs.findIndex((l) => l.includes(name))
		expect(nameIdx, `entry for ${name}`).toBeGreaterThanOrEqual(0)
		const valueIdx = logs.findIndex((l, idx) => idx > nameIdx && (/set: /.test(l) || l.includes(NOT_SET)))
		return valueIdx >= 0 ? logs[valueIdx] : ""
	}
	const NOT_SET = "(not set)"

	it("never prints internal/dev variables", async () => {
		await runEnv([])
		const output = logs.join("\n")
		for (const name of [...IGNORED_ENV_VARS, ...TEST_SUITE_ENV_VARS]) {
			expect(output, `${name} should stay hidden`).not.toContain(name)
		}
	})

	it("omits values by default; --values prints the current state", async () => {
		vi.stubEnv("KIMCHI_REGION", "eu")

		await runEnv([])
		const bare = logs.join("\n")
		expect(bare).toContain("KIMCHI_REGION")
		expect(bare).not.toContain("set: eu")
		expect(bare).not.toContain("(not set)")

		logs = []
		await runEnv(["--values"])
		const withValues = logs.join("\n")
		expect(withValues).toContain("set: eu")
		expect(withValues).toContain("(not set)")
	})

	it("masks secret values and prints non-secret ones", async () => {
		vi.stubEnv("KIMCHI_API_KEY", "super-secret-key")
		vi.stubEnv("KIMCHI_REGION", "eu")
		await runEnv(["--values"])
		const output = logs.join("\n")
		expect(output).not.toContain("super-secret-key")
		expect(output).toContain("set: ****")
		expect(output).toContain("set: eu")
	})

	it("marks unset variables as not set", async () => {
		// A raw delete is the only way to simulate "not exported". The host
		// environment may export KIMCHI_REGION (e.g. eu-region CI), so capture
		// and restore it — the delete is NOT covered by vi.unstubAllEnvs().
		const previous = process.env.KIMCHI_REGION
		delete process.env.KIMCHI_REGION
		try {
			await runEnv(["--values"])
			expect(logs.join("\n")).toContain("(not set)")
		} finally {
			if (previous !== undefined) process.env.KIMCHI_REGION = previous
		}
	})

	it("treats an explicitly empty value as not set — never as a masked secret", async () => {
		vi.stubEnv("KIMCHI_API_KEY", "")
		await runEnv(["--values"])
		const valueLine = valueLineFor("KIMCHI_API_KEY")
		expect(valueLine).toContain("(not set)")
		expect(valueLine).not.toContain("set: ****")
	})

	it("prints usage on --help without the variable list", async () => {
		expect(await runEnv(["--help"])).toBe(0)
		const output = logs.join("\n")
		expect(output).toContain("Usage: kimchi env")
		expect(output).not.toContain("KIMCHI_API_KEY")
	})

	it("redacts credentials embedded in URL-valued variables", async () => {
		vi.stubEnv("KIMCHI_PROXY", "http://[REDACTED-URL_WITH_CREDENTIALS]@proxy.internal:8080")
		await runEnv(["--values"])
		const valueLine = valueLineFor("KIMCHI_PROXY")
		expect(valueLine).not.toContain("ci-user")
		expect(valueLine).not.toContain("s3cret-pass")
		expect(valueLine).toContain("set: http://****@proxy.internal:8080")
	})

	it("leaves credential-free and non-URL values untouched", async () => {
		vi.stubEnv("KIMCHI_PROXY", "http://proxy.internal:8080")
		vi.stubEnv("KIMCHI_TAGS", "env:dbg,run:42")
		await runEnv(["--values"])
		const output = logs.join("\n")
		expect(output).toContain("set: http://proxy.internal:8080")
		expect(output).toContain("set: env:dbg,run:42")
	})

	it("rejects unknown arguments with usage and a non-zero exit", async () => {
		const errors: string[] = []
		vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
			errors.push(String(msg))
		})
		expect(await runEnv(["--bogus"])).not.toBe(0)
		const stderr = errors.join("\n")
		expect(stderr).toContain("Usage: kimchi env")
		expect(stderr).toContain('"--bogus"')
		expect(logs.join("\n")).not.toContain("KIMCHI_API_KEY")
	})
})
