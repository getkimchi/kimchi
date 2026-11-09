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

	/** Value line of a registry entry — the `set` / `(not set)` marker row. */
	function valueLineFor(name: string): string {
		const nameIdx = logs.findIndex((l) => l.includes(name))
		expect(nameIdx, `entry for ${name}`).toBeGreaterThanOrEqual(0)
		const valueIdx = logs.findIndex((l, idx) => idx > nameIdx && (l.includes(NOT_SET) || l.trim() === "set"))
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

	it("omits markers by default; --values prints set/not-set only, never the value", async () => {
		vi.stubEnv("KIMCHI_REGION", "eu")

		await runEnv([])
		const bare = logs.join("\n")
		expect(bare).toContain("KIMCHI_REGION")
		expect(
			logs.every((l) => l.trim() !== "set"),
			"no value lines without --values",
		).toBe(true)
		expect(bare).not.toContain(NOT_SET)
		expect(
			logs.every((l) => l.trim() !== "eu"),
			"value must not appear as its own row",
		).toBe(true)

		logs = []
		await runEnv(["--values"])
		expect(valueLineFor("KIMCHI_REGION").trim()).toBe("set")
		expect(logs.join("\n")).toContain(NOT_SET)
		// The value itself is never disclosed as an output row — note
		// "eu" legitimately appears inside the KIMCHI_REGION description text.
		expect(
			logs.every((l) => l.trim() !== "eu"),
			"value must not appear as its own row",
		).toBe(true)
	})

	it("never prints the value of any variable, whatever it contains", async () => {
		// Values spanning the previous leak classes: secret, credential-bearing
		// URL (built at runtime — a static userinfo fixture gets rewritten by
		// secret scanners), free-text tags, and control-character injection.
		const urlPassword = ["ci-user", "s3cret"].join(":") + String.fromCharCode(64)
		vi.stubEnv("KIMCHI_API_KEY", "super-secret-key")
		vi.stubEnv("KIMCHI_PROXY", `http://${urlPassword}proxy.internal:8080`)
		vi.stubEnv("KIMCHI_TAGS", "env:dbg,owner:[REDACTED-EMAIL_ADDRESS]")
		vi.stubEnv("KIMCHI_REGION", "region-with\nnewline\x1b[2J")
		await runEnv(["--values"])
		const output = logs.join("\n")
		for (const leaked of [
			"super-secret-key",
			"ci-user",
			"s3cret",
			"proxy.internal",
			"[REDACTED-EMAIL_ADDRESS]",
			"region-with",
			"\x1b",
		]) {
			expect(output, `value content must never reach output: ${JSON.stringify(leaked)}`).not.toContain(leaked)
		}
		expect(valueLineFor("KIMCHI_API_KEY").trim()).toBe("set")
		expect(valueLineFor("KIMCHI_PROXY").trim()).toBe("set")
		expect(valueLineFor("KIMCHI_REGION").trim()).toBe("set")
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

	it("treats an explicitly empty value as not set", async () => {
		vi.stubEnv("KIMCHI_API_KEY", "")
		await runEnv(["--values"])
		const valueLine = valueLineFor("KIMCHI_API_KEY")
		expect(valueLine).toContain("(not set)")
		expect(valueLine.trim()).not.toBe("set")
	})

	it("prints usage on --help without the variable list", async () => {
		expect(await runEnv(["--help"])).toBe(0)
		const output = logs.join("\n")
		expect(output).toContain("Usage: kimchi env")
		expect(output).not.toContain("KIMCHI_API_KEY")
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

	it("rejects an unknown argument even when --help is also passed", async () => {
		const errors: string[] = []
		vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
			errors.push(String(msg))
		})
		expect(await runEnv(["--bogus", "--help"])).not.toBe(0)
		expect(errors.join("\n")).toContain('"--bogus"')
	})

	it("lists the user-facing KIMCHI_BROWSER override", async () => {
		await runEnv([])
		expect(logs.join("\n")).toContain("KIMCHI_BROWSER")
	})

	it("decides colour use per call, honouring NO_COLOR set after process start", async () => {
		// Pin the host's NO_COLOR: with NO_COLOR=1 exported in CI the first
		// (colour-on) assertion would fail even though the code is right.
		vi.stubEnv("NO_COLOR", "")
		const stdout = process.stdout as { isTTY?: boolean }
		const previousIsTTY = stdout.isTTY
		stdout.isTTY = true
		try {
			// With colour available the header is bolded.
			await runEnv([])
			expect(logs[0]).toContain("\x1b[1m")

			// A NO_COLOR export after module import must still take effect.
			vi.stubEnv("NO_COLOR", "1")
			logs = []
			await runEnv([])
			expect(logs[0]).not.toContain("\x1b[")
		} finally {
			if (previousIsTTY === undefined) stdout.isTTY = undefined
			else stdout.isTTY = previousIsTTY
		}
	})
})
