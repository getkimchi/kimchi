import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runEnv } from "./env.js"

/**
 * `kimchi env` subcommand tests (list/which/create). Output is captured via
 * console spies; the fake home controls both the legacy-layout probe and the
 * envs/ tree location, and the KIMCHI_ENV* variables (scrubbed per test —
 * the enclosing kimchi session exports them) control the active env.
 */
describe("kimchi env subcommands", () => {
	let home: string
	let savedHome: string | undefined
	const envKeys = ["KIMCHI_ENV", "KIMCHI_ENV_ROOT", "KIMCHI_ENV_LEGACY_DEFAULT"] as const
	const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {}
	const logs: string[] = []
	const errors: string[] = []

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kimchi-env-command-"))
		savedHome = process.env.HOME
		process.env.HOME = home
		process.env.USERPROFILE = home
		for (const key of envKeys) {
			saved[key] = process.env[key]
			delete process.env[key]
		}
		logs.length = 0
		errors.length = 0
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.join(" "))
		})
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			errors.push(a.join(" "))
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		if (savedHome === undefined) delete process.env.HOME
		else process.env.HOME = savedHome
		for (const key of envKeys) {
			const value = saved[key]
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		rmSync(home, { recursive: true, force: true })
	})

	function output(): string {
		return logs.join("\n")
	}

	function errorOutput(): string {
		return errors.join("\n")
	}

	function seedLegacyLayout(): void {
		mkdirSync(join(home, ".config", "kimchi"), { recursive: true })
		writeFileSync(join(home, ".config", "kimchi", "config.json"), "{}\n")
	}

	function setActiveEnv(name: string, legacyDefault: boolean): void {
		const root = legacyDefault ? join(home, ".config", "kimchi") : join(home, ".config", "kimchi", "envs", name)
		process.env.KIMCHI_ENV = name
		process.env.KIMCHI_ENV_ROOT = root
		process.env.KIMCHI_ENV_LEGACY_DEFAULT = legacyDefault ? "1" : "0"
	}

	describe("env list", () => {
		it("shows default (legacy layout) on a machine with the legacy layout", async () => {
			seedLegacyLayout()
			expect(await runEnv(["list"])).toBe(0)
			expect(output()).toContain("default (legacy layout)")
			expect(output()).toContain(join(home, ".config", "kimchi"))
		})

		it("lists named envs and marks the active one", async () => {
			seedLegacyLayout()
			mkdirSync(join(home, ".config", "kimchi", "envs", "ci"), { recursive: true })
			mkdirSync(join(home, ".config", "kimchi", "envs", "staging"), { recursive: true })
			setActiveEnv("ci", false)
			expect(await runEnv(["list"])).toBe(0)
			const out = output()
			expect(out).toContain("* ci")
			expect(out).toContain(join(home, ".config", "kimchi", "envs", "ci"))
			expect(out).toContain("staging")
			expect(out).not.toContain("* staging")
			expect(out).toContain("default (legacy layout)")
			expect(out).not.toContain("* default")
		})

		it("shows the implicit envs/default on a fresh machine", async () => {
			expect(await runEnv(["list"])).toBe(0)
			const out = output()
			expect(out).toContain("default")
			expect(out).toContain(join(home, ".config", "kimchi", "envs", "default"))
		})

		it("ignores non-env entries in the envs directory", async () => {
			mkdirSync(join(home, ".config", "kimchi", "envs", "not!an!env"), { recursive: true })
			mkdirSync(join(home, ".config", "kimchi", "envs", "ci"), { recursive: true })
			expect(await runEnv(["list"])).toBe(0)
			const out = output()
			expect(out).toContain("ci")
			expect(out).not.toContain("not!an!env")
		})
	})

	describe("env which", () => {
		it("prints the active named env and its root", async () => {
			setActiveEnv("ci", false)
			expect(await runEnv(["which"])).toBe(0)
			const out = output()
			expect(out).toContain("ci")
			expect(out).toContain(join(home, ".config", "kimchi", "envs", "ci"))
		})

		it("marks the legacy default", async () => {
			seedLegacyLayout()
			setActiveEnv("default", true)
			expect(await runEnv(["which"])).toBe(0)
			expect(output()).toContain("default (legacy layout)")
		})

		it("falls back to the machine default when no env was resolved", async () => {
			seedLegacyLayout()
			expect(await runEnv(["which"])).toBe(0)
			expect(output()).toContain("default (legacy layout)")
		})
	})

	describe("env create", () => {
		it("creates the env root with a harness dir", async () => {
			expect(await runEnv(["create", "ci"])).toBe(0)
			expect(existsSync(join(home, ".config", "kimchi", "envs", "ci", "harness"))).toBe(true)
			expect(output()).toContain('Created environment "ci"')
			expect(output()).toContain("--env ci")
		})

		it("rejects invalid names with a clear error", async () => {
			expect(await runEnv(["create", "../evil"])).toBe(2)
			expect(errorOutput()).toContain("invalid environment name")
			expect(existsSync(join(home, ".config", "kimchi", "envs"))).toBe(false)
		})

		it("rejects the reserved name default", async () => {
			expect(await runEnv(["create", "default"])).toBe(2)
			expect(errorOutput()).toContain("reserved")
		})

		it("refuses to overwrite an existing env", async () => {
			expect(await runEnv(["create", "ci"])).toBe(0)
			expect(await runEnv(["create", "ci"])).toBe(1)
			expect(errorOutput()).toContain("already exists")
		})

		it("refuses a pre-planted symlink at envs/<name> (no silent redirect)", async () => {
			const target = mkdtempSync(join(tmpdir(), "kimchi-symlink-target-"))
			mkdirSync(join(home, ".config", "kimchi", "envs"), { recursive: true })
			symlinkSync(target, join(home, ".config", "kimchi", "envs", "ci"))
			expect(await runEnv(["create", "ci"])).toBe(1)
			expect(errorOutput()).toContain("not a directory")
		})

		it("survives a dangling symlink at envs/<name>/harness with a clean error", async () => {
			mkdirSync(join(home, ".config", "kimchi", "envs", "ci"), { recursive: true })
			// Dangling by construction — the target does not exist.
			symlinkSync(join(home, "nope"), join(home, ".config", "kimchi", "envs", "ci", "harness"))
			expect(await runEnv(["create", "ci"])).toBe(1)
			expect(errorOutput()).toContain("cannot create")
		})
	})

	describe("backward compatibility", () => {
		it("bare `kimchi env` still lists environment variables", async () => {
			expect(await runEnv([])).toBe(0)
			expect(output()).toContain("Environment variables recognised by kimchi")
		})

		it("`kimchi env vars` lists environment variables", async () => {
			expect(await runEnv(["vars"])).toBe(0)
			expect(output()).toContain("Environment variables recognised by kimchi")
		})

		it("`kimchi env vars --values` keeps the values flag", async () => {
			expect(await runEnv(["vars", "--values"])).toBe(0)
			expect(output()).toContain("Environment variables recognised by kimchi")
		})

		it("unknown subcommands error with usage", async () => {
			expect(await runEnv(["bogus"])).toBe(1)
			expect(errorOutput()).toContain('unknown subcommand "bogus"')
			expect(errorOutput()).toContain("Usage: kimchi env")
		})
	})
})
