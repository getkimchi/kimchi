import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runProfile } from "./profile.js"

/**
 * `kimchi profile` subcommand tests (list/which/create/vars). Output is
 * captured via console spies; the fake home controls the profiles/ tree
 * location, and the KIMCHI_PROFILE* variables (scrubbed per test — the
 * enclosing kimchi session exports them) control the active profile.
 */
describe("kimchi profile subcommands", () => {
	let home: string
	let savedHome: string | undefined
	const envKeys = ["KIMCHI_PROFILE", "KIMCHI_PROFILE_ROOT", "KIMCHI_PROFILE_DEFAULT"] as const
	const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {}
	const logs: string[] = []
	const errors: string[] = []

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kimchi-profile-command-"))
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

	function setActiveProfile(name: string, defaultProfile: boolean): void {
		const root = defaultProfile ? join(home, ".config", "kimchi") : join(home, ".config", "kimchi", "profiles", name)
		process.env.KIMCHI_PROFILE = name
		process.env.KIMCHI_PROFILE_ROOT = root
		process.env.KIMCHI_PROFILE_DEFAULT = defaultProfile ? "1" : "0"
	}

	describe("profile list", () => {
		it("shows the default profile at ~/.config/kimchi — on every machine", async () => {
			// Fresh machine, no state at all:
			expect(await runProfile(["list"])).toBe(0)
			let out = output()
			expect(out).toContain("default")
			expect(out).toContain(join(home, ".config", "kimchi"))
			expect(out).not.toContain(join(home, ".config", "kimchi", "profiles", "default"))

			// Machine with existing state — same answer:
			mkdirSync(join(home, ".config", "kimchi", "harness"), { recursive: true })
			expect(await runProfile(["list"])).toBe(0)
			out = output()
			expect(out).toContain("default")
			expect(out).toContain(join(home, ".config", "kimchi"))
		})

		it("lists named profiles and marks the active one", async () => {
			mkdirSync(join(home, ".config", "kimchi", "profiles", "ci"), { recursive: true })
			mkdirSync(join(home, ".config", "kimchi", "profiles", "staging"), { recursive: true })
			setActiveProfile("ci", false)
			expect(await runProfile(["list"])).toBe(0)
			const out = output()
			expect(out).toContain("* ci")
			expect(out).toContain(join(home, ".config", "kimchi", "profiles", "ci"))
			expect(out).toContain("staging")
			expect(out).not.toContain("* staging")
			expect(out).toContain("default")
			expect(out).not.toContain("* default")
		})

		it("ignores non-profile entries in the profiles directory", async () => {
			mkdirSync(join(home, ".config", "kimchi", "profiles", "not!a!profile"), { recursive: true })
			mkdirSync(join(home, ".config", "kimchi", "profiles", "ci"), { recursive: true })
			expect(await runProfile(["list"])).toBe(0)
			const out = output()
			expect(out).toContain("ci")
			expect(out).not.toContain("not!a!profile")
		})
	})

	describe("profile which", () => {
		it("prints the active named profile and its root", async () => {
			setActiveProfile("ci", false)
			expect(await runProfile(["which"])).toBe(0)
			const out = output()
			expect(out).toContain("ci")
			expect(out).toContain(join(home, ".config", "kimchi", "profiles", "ci"))
		})

		it("prints the default profile and its root", async () => {
			setActiveProfile("default", true)
			expect(await runProfile(["which"])).toBe(0)
			const out = output()
			expect(out).toContain("default")
			expect(out).toContain(join(home, ".config", "kimchi"))
		})

		it("falls back to the machine default when no profile was resolved", async () => {
			expect(await runProfile(["which"])).toBe(0)
			const out = output()
			expect(out).toContain("default")
			expect(out).toContain(join(home, ".config", "kimchi"))
		})
	})

	describe("profile create", () => {
		it("creates the profile root with a harness dir", async () => {
			expect(await runProfile(["create", "ci"])).toBe(0)
			expect(existsSync(join(home, ".config", "kimchi", "profiles", "ci", "harness"))).toBe(true)
			expect(output()).toContain('Created profile "ci"')
			expect(output()).toContain("--profile ci")
		})

		it("rejects invalid names with a clear error", async () => {
			expect(await runProfile(["create", "../evil"])).toBe(2)
			expect(errorOutput()).toContain("invalid profile name")
			expect(existsSync(join(home, ".config", "kimchi", "profiles"))).toBe(false)
		})

		it("rejects the reserved name default", async () => {
			expect(await runProfile(["create", "default"])).toBe(2)
			expect(errorOutput()).toContain("reserved")
		})

		it("refuses to overwrite an existing profile", async () => {
			expect(await runProfile(["create", "ci"])).toBe(0)
			expect(await runProfile(["create", "ci"])).toBe(1)
			expect(errorOutput()).toContain("already exists")
		})

		it("refuses a pre-planted symlink at profiles/<name> (no silent redirect)", async () => {
			const target = mkdtempSync(join(tmpdir(), "kimchi-symlink-target-"))
			mkdirSync(join(home, ".config", "kimchi", "profiles"), { recursive: true })
			symlinkSync(target, join(home, ".config", "kimchi", "profiles", "ci"))
			expect(await runProfile(["create", "ci"])).toBe(1)
			expect(errorOutput()).toContain("not a directory")
		})

		it("survives a dangling symlink at profiles/<name>/harness with a clean error", async () => {
			mkdirSync(join(home, ".config", "kimchi", "profiles", "ci"), { recursive: true })
			// Dangling by construction — the target does not exist.
			symlinkSync(join(home, "nope"), join(home, ".config", "kimchi", "profiles", "ci", "harness"))
			expect(await runProfile(["create", "ci"])).toBe(1)
			expect(errorOutput()).toContain("cannot create")
		})
	})

	describe("profile vars", () => {
		it("bare `kimchi profile` prints usage, not the variable list", async () => {
			expect(await runProfile([])).toBe(0)
			expect(output()).toContain("Usage: kimchi profile")
			expect(output()).not.toContain("Environment variables recognised by kimchi")
		})

		it("`kimchi profile vars` lists environment variables", async () => {
			expect(await runProfile(["vars"])).toBe(0)
			expect(output()).toContain("Environment variables recognised by kimchi")
		})

		it("`kimchi profile vars --values` keeps the values flag", async () => {
			expect(await runProfile(["vars", "--values"])).toBe(0)
			expect(output()).toContain("Environment variables recognised by kimchi")
		})

		it("unknown subcommands error with usage", async () => {
			expect(await runProfile(["bogus"])).toBe(1)
			expect(errorOutput()).toContain('unknown subcommand "bogus"')
			expect(errorOutput()).toContain("Usage: kimchi profile")
		})
	})
})
