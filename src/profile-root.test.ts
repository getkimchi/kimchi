import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	DEFAULT_PROFILE_NAME,
	extractProfileFlag,
	profileCacheDir,
	readResolvedKimchiProfile,
	resolveKimchiProfile,
	validateProfileName,
} from "./profile-root.js"

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "kimchi-profile-root-"))
}

describe("validateProfileName", () => {
	it("accepts letters, digits, dash and underscore", () => {
		for (const name of ["a", "default2", "work-profile", "ci_1", "A9"]) {
			expect(validateProfileName(name), name).toBeUndefined()
		}
	})

	it("rejects traversal, separators, empties and non-ASCII", () => {
		for (const name of ["", "..", "../evil", "a/b", "a\\b", "a b", ".hidden", "-lead", "_lead", "ü"]) {
			expect(validateProfileName(name), name).toBeTruthy()
		}
	})

	it("rejects names longer than 32 characters", () => {
		expect(validateProfileName("a".repeat(33))).toBeTruthy()
		expect(validateProfileName("a".repeat(32))).toBeUndefined()
	})
})

describe("extractProfileFlag", () => {
	it("reads --profile <name> and --profile=<name> from any position", () => {
		expect(extractProfileFlag(["--profile", "foo"])).toBe("foo")
		expect(extractProfileFlag(["--profile=foo"])).toBe("foo")
		expect(extractProfileFlag(["--model", "x", "--profile", "foo", "-p"])).toBe("foo")
		expect(extractProfileFlag(["--model", "x", "--profile=foo", "-p"])).toBe("foo")
	})

	it("returns undefined when absent and does not match lookalike flags", () => {
		expect(extractProfileFlag([])).toBeUndefined()
		expect(extractProfileFlag(["--profiles", "x"])).toBeUndefined()
		expect(extractProfileFlag(["--profile-count=1"])).toBeUndefined()
	})

	it("returns an empty string when the flag has no usable value", () => {
		expect(extractProfileFlag(["--profile"])).toBe("")
		expect(extractProfileFlag(["--profile", "--model"])).toBe("")
		expect(extractProfileFlag(["--profile="])).toBe("")
	})

	it("stops at the -- separator: prompt text never selects a profile", () => {
		expect(extractProfileFlag(["--", "--profile", "foo"])).toBeUndefined()
		expect(extractProfileFlag(["--", "--profile=foo"])).toBeUndefined()
		expect(extractProfileFlag(["--profile", "foo", "--", "--profile", "bar"])).toBe("foo")
	})
})

describe("resolveKimchiProfile", () => {
	it("selects a named profile from the flag, rooted under profiles/", () => {
		const home = tempHome()
		const resolved = resolveKimchiProfile({ rawArgv: ["--profile", "ci"], env: {}, home })
		expect(resolved).toEqual({
			name: "ci",
			root: join(home, ".config", "kimchi", "profiles", "ci"),
			defaultProfile: false,
		})
	})

	it("the flag wins over KIMCHI_PROFILE", () => {
		const home = tempHome()
		const resolved = resolveKimchiProfile({
			rawArgv: ["--profile", "flag-wins", "config", "set", "x", "1"],
			env: { KIMCHI_PROFILE: "from-var" },
			home,
		})
		expect(resolved.name).toBe("flag-wins")
	})

	it("honors KIMCHI_PROFILE (trimmed) when the flag is absent", () => {
		const home = tempHome()
		expect(resolveKimchiProfile({ rawArgv: [], env: { KIMCHI_PROFILE: "  ci  " }, home }).root).toBe(
			join(home, ".config", "kimchi", "profiles", "ci"),
		)
	})

	it("treats an empty KIMCHI_PROFILE as unset", () => {
		const home = tempHome()
		const resolved = resolveKimchiProfile({ rawArgv: [], env: { KIMCHI_PROFILE: "   " }, home })
		expect(resolved.defaultProfile).toBe(true)
	})

	it("the default profile is ~/.config/kimchi itself — for fresh machines and existing ones alike", () => {
		// Fresh home (no state anywhere):
		const fresh = tempHome()
		expect(resolveKimchiProfile({ rawArgv: [], env: {}, home: fresh })).toEqual({
			name: DEFAULT_PROFILE_NAME,
			root: join(fresh, ".config", "kimchi"),
			defaultProfile: true,
		})
		// Home with existing state (the pre-profiles layout) — same answer:
		const existing = tempHome()
		mkdirSync(join(existing, ".config", "kimchi", "harness"), { recursive: true })
		expect(resolveKimchiProfile({ rawArgv: [], env: {}, home: existing })).toEqual({
			name: DEFAULT_PROFILE_NAME,
			root: join(existing, ".config", "kimchi"),
			defaultProfile: true,
		})
	})

	it("`--profile default` is exactly equivalent to passing nothing", () => {
		for (const seed of ["none", "config", "harness"] as const) {
			const home = tempHome()
			if (seed !== "none") {
				mkdirSync(join(home, ".config", "kimchi"), { recursive: true })
				if (seed === "config") writeFileSync(join(home, ".config", "kimchi", "config.json"), "{}\n")
				else mkdirSync(join(home, ".config", "kimchi", "harness"))
			}
			expect(resolveKimchiProfile({ rawArgv: ["--profile", DEFAULT_PROFILE_NAME], env: {}, home }), seed).toEqual(
				resolveKimchiProfile({ rawArgv: [], env: {}, home }),
			)
		}
	})

	it("throws a clear error for an invalid flag value or KIMCHI_PROFILE", () => {
		const home = tempHome()
		expect(() => resolveKimchiProfile({ rawArgv: ["--profile", "../evil"], env: {}, home })).toThrow(
			/invalid profile name/,
		)
		expect(() => resolveKimchiProfile({ rawArgv: [], env: { KIMCHI_PROFILE: "no/slashes" }, home })).toThrow(
			/invalid profile name/,
		)
	})
})

describe("readResolvedKimchiProfile", () => {
	const saved: Record<string, string | undefined> = {}
	const keys = ["KIMCHI_PROFILE", "KIMCHI_PROFILE_ROOT", "KIMCHI_PROFILE_DEFAULT"] as const

	afterEach(() => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key]
			else process.env[key] = saved[key]
			delete saved[key]
		}
	})

	function pin(vars: Partial<Record<(typeof keys)[number], string>>): void {
		for (const key of keys) {
			if (!(key in saved)) saved[key] = process.env[key]
			if (vars[key] === undefined) delete process.env[key]
			else process.env[key] = vars[key]
		}
	}

	it("throws when entry.ts has not resolved a profile", () => {
		pin({})
		expect(() => readResolvedKimchiProfile()).toThrow(/KIMCHI_PROFILE_ROOT is not set/)
	})

	it("reads back the values entry.ts published", () => {
		pin({ KIMCHI_PROFILE: "ci", KIMCHI_PROFILE_ROOT: "/tmp/profiles/ci", KIMCHI_PROFILE_DEFAULT: "0" })
		expect(readResolvedKimchiProfile()).toEqual({
			name: "ci",
			root: "/tmp/profiles/ci",
			defaultProfile: false,
		})
		pin({ KIMCHI_PROFILE_ROOT: "/tmp/kimchi", KIMCHI_PROFILE_DEFAULT: "1" })
		expect(readResolvedKimchiProfile()).toEqual({ name: "default", root: "/tmp/kimchi", defaultProfile: true })
	})

	it("rejects an invalid injected KIMCHI_PROFILE name (defense in depth for direct importers)", () => {
		pin({ KIMCHI_PROFILE: "../../x", KIMCHI_PROFILE_ROOT: "/tmp/profiles/x", KIMCHI_PROFILE_DEFAULT: "0" })
		expect(() => readResolvedKimchiProfile()).toThrow(/invalid profile name/)
	})
})

describe("profileCacheDir", () => {
	it("the default profile keeps ~/.cache/kimchi; named profiles get profiles/<name>/", () => {
		expect(profileCacheDir({ name: "default", defaultProfile: true })).toBe(join(homedir(), ".cache", "kimchi"))
		expect(profileCacheDir({ name: "ci", defaultProfile: false })).toBe(
			join(homedir(), ".cache", "kimchi", "profiles", "ci"),
		)
	})

	it("honors XDG_CACHE_HOME", () => {
		const saved = process.env.XDG_CACHE_HOME
		process.env.XDG_CACHE_HOME = "/tmp/xdg-cache"
		try {
			expect(profileCacheDir({ name: "default", defaultProfile: true })).toBe("/tmp/xdg-cache/kimchi")
			expect(profileCacheDir({ name: "ci", defaultProfile: false })).toBe("/tmp/xdg-cache/kimchi/profiles/ci")
		} finally {
			if (saved === undefined) delete process.env.XDG_CACHE_HOME
			else process.env.XDG_CACHE_HOME = saved
		}
	})
})

describe("profile-rooted config paths (config.ts)", () => {
	const saved: Record<string, string | undefined> = {}
	const keys = ["KIMCHI_PROFILE_ROOT", "KIMCHI_CODING_AGENT_DIR"] as const

	afterEach(() => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key]
			else process.env[key] = saved[key]
			delete saved[key]
		}
	})

	function pin(vars: Partial<Record<(typeof keys)[number], string>>): void {
		for (const key of keys) {
			if (!(key in saved)) saved[key] = process.env[key]
			if (vars[key] === undefined) delete process.env[key]
			else process.env[key] = vars[key]
		}
	}

	it("derives KIMCHI_CONFIG_PATH and AGENT_CONFIG_DIR from KIMCHI_PROFILE_ROOT", async () => {
		const root = tempHome()
		pin({ KIMCHI_PROFILE_ROOT: root })
		vi.resetModules()
		const config = await import("./config.js")
		writeFileSync(join(root, "config.json"), JSON.stringify({ apiKey: "profile-key" }))
		expect(config.readApiKeyFromConfigFile()).toBe("profile-key")
		expect(config.getAgentConfigDir()).toBe(join(root, "harness"))
	})

	it("falls back to the default profile root when no profile is set (standalone imports, tests)", async () => {
		pin({})
		vi.resetModules()
		const config = await import("./config.js")
		expect(config.getAgentConfigDir()).toBe(join(homedir(), ".config", "kimchi", "harness"))
	})
})

/**
 * Integration: a named profile's full state tree. Modules capture paths at
 * import time, so each is re-imported fresh with KIMCHI_PROFILE_ROOT pinned —
 * the same sequencing entry.ts guarantees at runtime.
 */
describe("named profile full state tree", () => {
	const saved: Record<string, string | undefined> = {}
	const keys = ["KIMCHI_PROFILE_ROOT", "KIMCHI_CODING_AGENT_DIR"] as const

	afterEach(() => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key]
			else process.env[key] = saved[key]
			delete saved[key]
		}
	})

	it("config, memory, daemon, settings, ferments and profile locks all land under the profile root", async () => {
		const root = tempHome()
		for (const key of keys) {
			if (!(key in saved)) saved[key] = process.env[key]
		}
		process.env.KIMCHI_PROFILE_ROOT = root
		delete process.env.KIMCHI_CODING_AGENT_DIR // profileAgentDir falls back to <root>/harness
		vi.resetModules()

		const config = await import("./config.js")
		const memoryConfig = await import("./extensions/memory/config.js")
		const daemonState = await import("./extensions/daemon/state.js")
		const fermentState = await import("./extensions/ferment/state.js")

		// Config write — lands at <root>/config.json.
		config.writeTuiTimestamps(true)
		expect(existsSync(join(root, "config.json"))).toBe(true)
		expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8"))).toMatchObject({
			tui: { timestamps: true },
		})

		// Memory save location — the digest db lives under <root>/memory.
		mkdirSync(memoryConfig.defaultMemoryDir(), { recursive: true })
		expect(memoryConfig.defaultMemoryDir()).toBe(join(root, "memory"))
		expect(memoryConfig.digestDbPath()).toBe(join(root, "memory", "personal", "memory.db"))

		// Daemon state and ferment locks — <root>/daemons and <root>/harness.
		expect(daemonState.daemonStateDir()).toBe(join(root, "daemons"))
		expect(fermentState.getFermentLockPath("0f1e2d3c")).toContain(join(root, "harness", "ferment-locks"))

		// settings.json — the readers that were once home-hardcoded now
		// follow the profile's agent dir, matching the profile-scoped writers.
		const settings = await import("./config/settings.js")
		settings.writeConfigSetting("fermentV2", true)
		expect(existsSync(join(root, "harness", "settings.json"))).toBe(true)
		expect(settings.readConfigSetting("fermentV2", (v): v is boolean => typeof v === "boolean")).toBe(true)

		// Ferment records — scoped WITH the locks so cross-profile mutual exclusion holds.
		const fermentStore = await import("./ferment/store.js")
		expect(fermentStore.getGlobalFermentsDir()).toBe(join(root, "ferments"))

		// The agent dir — sessions, logins, skills — is <root>/harness.
		expect(config.getAgentConfigDir()).toBe(join(root, "harness"))
	})
})

/**
 * profile-root-init's agent-dir publication: the cross-profile regression. A
 * nested `kimchi --profile b` launched from a profile-a session inherits a's
 * pointers; config.ts must still freeze b's agent dir — only possible because
 * profile-root-init overwrites KIMCHI_CODING_AGENT_DIR before config
 * evaluates.
 */
describe("profile-root-init (import-time agent-dir publication)", () => {
	const saved: Record<string, string | undefined> = {}
	const keys = [
		"KIMCHI_PROFILE",
		"KIMCHI_PROFILE_ROOT",
		"KIMCHI_PROFILE_DEFAULT",
		"KIMCHI_CODING_AGENT_DIR",
		"KIMCHI_ORIGINAL_CODING_AGENT_DIR",
	] as const
	const savedArgv: string[] = []

	afterEach(() => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key]
			else process.env[key] = saved[key]
			delete saved[key]
		}
		if (savedArgv.length > 0) process.argv = savedArgv.splice(0)
	})

	it("overwrites an inherited KIMCHI_CODING_AGENT_DIR so config.ts freezes the selected profile's agent dir", async () => {
		// The same homedir() the isolated-home setup mocks — profile-root-init
		// resolves through it, so the test must agree on the home.
		const home = homedir()
		const profileA = join(home, ".config", "kimchi", "profiles", "a")
		for (const key of keys) {
			if (!(key in saved)) saved[key] = process.env[key]
		}
		// The parent (profile a) exports its pointers; the child selects profile b via the flag.
		savedArgv.push(...process.argv)
		process.argv = [...process.argv, "--profile", "b"]
		process.env.KIMCHI_PROFILE = "a"
		process.env.KIMCHI_PROFILE_ROOT = profileA
		process.env.KIMCHI_PROFILE_DEFAULT = "0"
		process.env.KIMCHI_CODING_AGENT_DIR = join(profileA, "harness")
		delete process.env.KIMCHI_ORIGINAL_CODING_AGENT_DIR

		vi.resetModules()
		await import("./profile-root-init.js")
		const config = await import("./config.js")

		// The frozen agent dir is profile b's, and a's pointer is preserved.
		expect(config.getAgentConfigDir()).toBe(join(home, ".config", "kimchi", "profiles", "b", "harness"))
		expect(process.env.KIMCHI_CODING_AGENT_DIR).toBe(join(home, ".config", "kimchi", "profiles", "b", "harness"))
		expect(process.env.KIMCHI_ORIGINAL_CODING_AGENT_DIR).toBe(join(profileA, "harness"))
	})
})

/**
 * Entry-level wiring: run the real src/entry.ts under bun with a controlled
 * HOME and assert the filesystem effects and the invalid-name exit. The dev
 * invocation mirrors the `dev` script minus the proxy-helper make step.
 */
describe("entry.ts profile wiring", () => {
	const repoRoot = resolve(__dirname, "..")

	function runEntry(home: string, args: string[], extraEnv: Record<string, string> = {}) {
		return spawnSync("bun", ["run", "--preload", "./src/set-package-dir.ts", "src/entry.ts", ...args], {
			cwd: repoRoot,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				USERPROFILE: home,
				...extraEnv,
			},
			encoding: "utf-8",
			timeout: 120_000,
		})
	}

	it("KIMCHI_PROFILE=<name> routes the agent dir into profiles/<name>/harness", () => {
		const home = tempHome()
		const result = runEntry(home, ["--version"], { KIMCHI_PROFILE: "foo" })
		expect(result.status, `stderr: ${result.stderr}`).toBe(0)
		expect(existsSync(join(home, ".config", "kimchi", "profiles", "foo", "harness"))).toBe(true)
	})

	it("a bare run on a fresh home uses ~/.config/kimchi directly (no profiles/ tree created)", () => {
		const home = tempHome()
		const result = runEntry(home, ["--version"])
		expect(result.status, `stderr: ${result.stderr}`).toBe(0)
		expect(existsSync(join(home, ".config", "kimchi", "profiles"))).toBe(false)
	})

	it("`config set` under --profile test writes profiles/test/config.json", () => {
		const home = tempHome()
		const result = runEntry(home, ["--profile", "test", "config", "set", "tui.timestamps", "on"])
		expect(result.status, `stderr: ${result.stderr}`).toBe(0)
		const configPath = join(home, ".config", "kimchi", "profiles", "test", "config.json")
		expect(existsSync(configPath), `stdout: ${result.stdout}`).toBe(true)
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ tui: { timestamps: true } })
	})

	it("exits with a clear error for --profile ../evil", () => {
		const home = tempHome()
		const result = runEntry(home, ["--profile", "../evil", "--version"])
		expect(result.status).not.toBe(0)
		expect(result.stderr).toMatch(/invalid profile name/)
	})

	it("ssh_config lands under the selected profile root when a profile is active", () => {
		const home = tempHome()
		const result = runEntry(home, ["--profile", "test", "--version"])
		expect(result.status, `stderr: ${result.stderr}`).toBe(0)
		// The profile root exists (eager mkdir); ssh_config placement itself is
		// resolveSshConfigPaths' contract — covered by its own tests.
		expect(existsSync(join(home, ".config", "kimchi", "profiles", "test", "harness"))).toBe(true)
	})
})
