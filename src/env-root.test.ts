import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import {
	DEFAULT_ENV_NAME,
	envCacheDir,
	extractEnvFlag,
	readResolvedKimchiEnv,
	resolveKimchiEnv,
	validateEnvName,
} from "./env-root.js"

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "kimchi-env-root-"))
}

/** Seed a home with a legacy top-level kimchi layout (config.json or harness/). */
function seedLegacyHome(home: string, kind: "config" | "harness"): void {
	const kimchi = join(home, ".config", "kimchi")
	mkdirSync(kimchi, { recursive: true })
	if (kind === "config") writeFileSync(join(kimchi, "config.json"), "{}\n")
	else mkdirSync(join(kimchi, "harness"))
}

describe("validateEnvName", () => {
	it("accepts names matching [a-zA-Z0-9][a-zA-Z0-9_-]*", () => {
		for (const name of ["default", "a", "TEST", "prod-2", "ci_eu", "0"]) {
			expect(validateEnvName(name), name).toBeUndefined()
		}
	})

	it("rejects empty, traversal, separator, leading-symbol, and whitespace names", () => {
		for (const name of ["", "..", "a/b", "a\\b", "-lead", "_lead", ".hidden", "has space", "é", "a\u0000b"]) {
			expect(validateEnvName(name), name).toBeDefined()
		}
	})

	it("rejects names longer than 32 characters", () => {
		expect(validateEnvName("a".repeat(32))).toBeUndefined()
		expect(validateEnvName("a".repeat(33))).toBeDefined()
	})
})

describe("extractEnvFlag", () => {
	it("reads --env <name> and --env=<name> from any position", () => {
		expect(extractEnvFlag(["--env", "foo"])).toBe("foo")
		expect(extractEnvFlag(["--env=foo"])).toBe("foo")
		expect(extractEnvFlag(["--model", "x", "--env", "foo", "-p"])).toBe("foo")
		expect(extractEnvFlag(["--model", "x", "--env=foo", "-p"])).toBe("foo")
	})

	it("returns undefined when absent and does not match lookalike flags", () => {
		expect(extractEnvFlag([])).toBeUndefined()
		expect(extractEnvFlag(["--environment", "x"])).toBeUndefined()
		expect(extractEnvFlag(["--envelope=1"])).toBeUndefined()
	})

	it("returns an empty string when the flag has no usable value", () => {
		expect(extractEnvFlag(["--env"])).toBe("")
		expect(extractEnvFlag(["--env", "--model"])).toBe("")
		expect(extractEnvFlag(["--env="])).toBe("")
	})

	it("stops at the -- separator: prompt text never selects an env", () => {
		expect(extractEnvFlag(["--", "--env", "foo"])).toBeUndefined()
		expect(extractEnvFlag(["--", "--env=foo"])).toBeUndefined()
		// Before the separator the flag still wins — and the first one at that.
		expect(extractEnvFlag(["--env", "foo", "--", "--env", "bar"])).toBe("foo")
	})
})

describe("resolveKimchiEnv", () => {
	it("selects a named env from the flag, rooted under envs/", () => {
		const home = tempHome()
		const resolved = resolveKimchiEnv({ rawArgv: ["--env", "ci"], env: {}, home })
		expect(resolved).toEqual({ name: "ci", root: join(home, ".config", "kimchi", "envs", "ci"), legacyDefault: false })
	})

	it("the flag wins over KIMCHI_ENV", () => {
		const home = tempHome()
		const resolved = resolveKimchiEnv({
			rawArgv: ["--env=flagenv"],
			env: { KIMCHI_ENV: "varenv" },
			home,
		})
		expect(resolved.name).toBe("flagenv")
	})

	it("honors KIMCHI_ENV (trimmed) when the flag is absent", () => {
		const home = tempHome()
		const resolved = resolveKimchiEnv({ rawArgv: [], env: { KIMCHI_ENV: " varenv " }, home })
		expect(resolved.name).toBe("varenv")
	})

	it("treats an empty KIMCHI_ENV as unset", () => {
		const home = tempHome()
		for (const raw of ["", "   "]) {
			expect(resolveKimchiEnv({ rawArgv: [], env: { KIMCHI_ENV: raw }, home }).name).toBe(DEFAULT_ENV_NAME)
		}
	})

	it("uses the legacy layout in place as the default env when config.json exists", () => {
		const home = tempHome()
		seedLegacyHome(home, "config")
		expect(resolveKimchiEnv({ rawArgv: [], env: {}, home })).toEqual({
			name: "default",
			root: join(home, ".config", "kimchi"),
			legacyDefault: true,
		})
	})

	it("uses the legacy layout in place as the default env when harness/ exists", () => {
		const home = tempHome()
		seedLegacyHome(home, "harness")
		const resolved = resolveKimchiEnv({ rawArgv: [], env: {}, home })
		expect(resolved.root).toBe(join(home, ".config", "kimchi"))
		expect(resolved.legacyDefault).toBe(true)
	})

	it("does not treat a bare envs/ directory or the machine-global ssh_config as a legacy layout", () => {
		const home = tempHome()
		mkdirSync(join(home, ".config", "kimchi", "envs", "other"), { recursive: true })
		// teleport writes its managed ssh_config at the legacy root even on
		// fresh machines — it must not flip their default env.
		writeFileSync(join(home, ".config", "kimchi", "ssh_config"), "# managed\n")
		const resolved = resolveKimchiEnv({ rawArgv: [], env: {}, home })
		expect(resolved.root).toBe(join(home, ".config", "kimchi", "envs", "default"))
		expect(resolved.legacyDefault).toBe(false)
	})

	it("treats partial legacy state (memory/, models-cache.json) as the legacy layout in place", () => {
		// A machine that only ever ran a partial kimchi (no config.json yet) must
		// not be flipped onto a fresh envs/default tree — its existing files
		// would be silently orphaned.
		for (const seed of ["memory", "models-cache.json", "daemons"] as const) {
			const home = tempHome()
			const kimchi = join(home, ".config", "kimchi")
			mkdirSync(kimchi, { recursive: true })
			if (seed.includes(".")) writeFileSync(join(kimchi, seed), "{}\n")
			else mkdirSync(join(kimchi, seed))
			const resolved = resolveKimchiEnv({ rawArgv: [], env: {}, home })
			expect(resolved.legacyDefault, `seed=${seed}`).toBe(true)
			expect(resolved.root, `seed=${seed}`).toBe(kimchi)
		}
	})

	it("`--env default` is exactly equivalent to passing nothing", () => {
		for (const seed of ["config", "harness"] as const) {
			const legacyHome = tempHome()
			seedLegacyHome(legacyHome, seed)
			const viaFlag = resolveKimchiEnv({ rawArgv: ["--env", "default"], env: {}, home: legacyHome })
			const implicit = resolveKimchiEnv({ rawArgv: [], env: {}, home: legacyHome })
			expect(viaFlag).toEqual(implicit)
		}
		const freshHome = tempHome()
		expect(resolveKimchiEnv({ rawArgv: ["--env", "default"], env: {}, home: freshHome })).toEqual(
			resolveKimchiEnv({ rawArgv: [], env: {}, home: freshHome }),
		)
	})

	it("throws a clear error for an invalid flag value or KIMCHI_ENV", () => {
		const home = tempHome()
		expect(() => resolveKimchiEnv({ rawArgv: ["--env", "../evil"], env: {}, home })).toThrow(/invalid environment name/)
		expect(() => resolveKimchiEnv({ rawArgv: ["--env"], env: {}, home })).toThrow(/must not be empty/)
		expect(() => resolveKimchiEnv({ rawArgv: [], env: { KIMCHI_ENV: "a/b" }, home })).toThrow(
			/invalid environment name/,
		)
	})
})

describe("readResolvedKimchiEnv", () => {
	const saved: Record<string, string | undefined> = {}
	const keys = ["KIMCHI_ENV", "KIMCHI_ENV_ROOT", "KIMCHI_ENV_LEGACY_DEFAULT"] as const

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

	it("throws when entry.ts has not resolved an environment", () => {
		pin({})
		expect(() => readResolvedKimchiEnv()).toThrow(/KIMCHI_ENV_ROOT is not set/)
	})

	it("reads back the values entry.ts published", () => {
		pin({ KIMCHI_ENV: "ci", KIMCHI_ENV_ROOT: "/tmp/envs/ci", KIMCHI_ENV_LEGACY_DEFAULT: "0" })
		expect(readResolvedKimchiEnv()).toEqual({
			name: "ci",
			root: "/tmp/envs/ci",
			legacyDefault: false,
		})
		pin({ KIMCHI_ENV_ROOT: "/tmp/legacy", KIMCHI_ENV_LEGACY_DEFAULT: "1" })
		expect(readResolvedKimchiEnv()).toEqual({ name: "default", root: "/tmp/legacy", legacyDefault: true })
	})

	it("rejects an invalid injected KIMCHI_ENV name (defense in depth for direct importers)", () => {
		pin({ KIMCHI_ENV: "../../x", KIMCHI_ENV_ROOT: "/tmp/envs/x", KIMCHI_ENV_LEGACY_DEFAULT: "0" })
		expect(() => readResolvedKimchiEnv()).toThrow(/invalid environment name/)
	})
})

describe("envCacheDir", () => {
	const previousXdg = process.env.XDG_CACHE_HOME
	afterAll(() => {
		if (previousXdg === undefined) delete process.env.XDG_CACHE_HOME
		else process.env.XDG_CACHE_HOME = previousXdg
	})

	it("keeps the legacy cache location for the legacy default env", () => {
		delete process.env.XDG_CACHE_HOME
		expect(envCacheDir({ name: "default", legacyDefault: true })).toBe(join(homedir(), ".cache", "kimchi"))
	})

	it("scopes named and fresh-default envs under envs/<name>/", () => {
		delete process.env.XDG_CACHE_HOME
		expect(envCacheDir({ name: "ci", legacyDefault: false })).toBe(join(homedir(), ".cache", "kimchi", "envs", "ci"))
		expect(envCacheDir({ name: "default", legacyDefault: false })).toBe(
			join(homedir(), ".cache", "kimchi", "envs", "default"),
		)
	})

	it("honors XDG_CACHE_HOME like src/update/paths.ts", () => {
		process.env.XDG_CACHE_HOME = "/xdg-cache"
		expect(envCacheDir({ name: "ci", legacyDefault: false })).toBe(join("/xdg-cache", "kimchi", "envs", "ci"))
	})
})

/**
 * Config-path routing: src/config.ts captures KIMCHI_CONFIG_PATH and
 * AGENT_CONFIG_DIR at module import, so these tests re-import it fresh
 * (vi.resetModules) with the env vars pinned — the same sequencing entry.ts
 * guarantees at runtime.
 */
describe("env-rooted config paths (config.ts)", () => {
	const saved: Record<string, string | undefined> = {}
	const keys = ["KIMCHI_ENV_ROOT", "KIMCHI_CODING_AGENT_DIR"] as const

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

	it("derives KIMCHI_CONFIG_PATH and AGENT_CONFIG_DIR from KIMCHI_ENV_ROOT", async () => {
		const root = tempHome()
		pin({ KIMCHI_ENV_ROOT: root })
		vi.resetModules()
		const config = await import("./config.js")
		writeFileSync(join(root, "config.json"), JSON.stringify({ apiKey: "env-key" }))
		expect(config.readApiKeyFromConfigFile()).toBe("env-key")
		expect(config.getAgentConfigDir()).toBe(join(root, "harness"))
	})

	it("getAgentConfigDir prefers KIMCHI_CODING_AGENT_DIR over the env root", async () => {
		const root = tempHome()
		pin({ KIMCHI_ENV_ROOT: join(root, "envs", "test"), KIMCHI_CODING_AGENT_DIR: join(root, "custom-harness") })
		vi.resetModules()
		const config = await import("./config.js")
		expect(config.getAgentConfigDir()).toBe(join(root, "custom-harness"))
	})

	it("falls back to the legacy layout when no env is set (standalone imports, tests)", async () => {
		pin({})
		vi.resetModules()
		const config = await import("./config.js")
		expect(config.getAgentConfigDir()).toBe(join(homedir(), ".config", "kimchi", "harness"))
		expect(config.readApiKeyFromConfigFile(join(homedir(), ".config", "kimchi", "config.json"))).toBe(
			config.readApiKeyFromConfigFile(),
		)
	})
})

/**
 * Integration: a named env's full state tree. Modules capture paths at
 * import time, so each is re-imported fresh with KIMCHI_ENV_ROOT pinned —
 * the same sequencing entry.ts guarantees at runtime.
 */
describe("named env full state tree", () => {
	const saved: Record<string, string | undefined> = {}
	const keys = ["KIMCHI_ENV_ROOT", "KIMCHI_CODING_AGENT_DIR"] as const

	afterEach(() => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key]
			else process.env[key] = saved[key]
			delete saved[key]
		}
	})

	it("config, memory, daemon, and ferment state all land under the env root", async () => {
		const root = tempHome()
		for (const key of keys) {
			if (!(key in saved)) saved[key] = process.env[key]
		}
		process.env.KIMCHI_ENV_ROOT = root
		delete process.env.KIMCHI_CODING_AGENT_DIR // envAgentDir falls back to <root>/harness
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

		// settings.json — the readers that were once legacy-hardcoded now
		// follow the env's agent dir, matching the env-scoped writers.
		const settings = await import("./config/settings.js")
		settings.writeConfigSetting("fermentV2", true)
		expect(existsSync(join(root, "harness", "settings.json"))).toBe(true)
		expect(settings.readConfigSetting("fermentV2", (v): v is boolean => typeof v === "boolean")).toBe(true)

		// Ferment records — scoped WITH the locks so cross-env mutual exclusion holds.
		const fermentStore = await import("./ferment/store.js")
		expect(fermentStore.getGlobalFermentsDir()).toBe(join(root, "ferments"))

		// The agent dir — sessions, logins, skills — is <root>/harness.
		expect(config.getAgentConfigDir()).toBe(join(root, "harness"))
	})
})

/**
 * env-root-init's agent-dir publication: the H1 regression. A nested
 * `kimchi --env b` launched from an env-a session inherits a's pointers;
 * config.ts must still freeze b's agent dir — only possible because
 * env-root-init overwrites KIMCHI_CODING_AGENT_DIR before config evaluates.
 */
describe("env-root-init (import-time agent-dir publication)", () => {
	const saved: Record<string, string | undefined> = {}
	const keys = [
		"KIMCHI_ENV",
		"KIMCHI_ENV_ROOT",
		"KIMCHI_ENV_LEGACY_DEFAULT",
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

	it("overwrites an inherited KIMCHI_CODING_AGENT_DIR so config.ts freezes the selected env's agent dir", async () => {
		// The same homedir() the isolated-home setup mocks — env-root-init
		// resolves through it, so the test must agree on the home.
		const home = homedir()
		const envA = join(home, ".config", "kimchi", "envs", "a")
		for (const key of keys) {
			if (!(key in saved)) saved[key] = process.env[key]
		}
		// The parent (env a) exports its pointers; the child selects env b via the flag.
		savedArgv.push(...process.argv)
		process.argv = [...process.argv, "--env", "b"]
		process.env.KIMCHI_ENV = "a"
		process.env.KIMCHI_ENV_ROOT = envA
		process.env.KIMCHI_ENV_LEGACY_DEFAULT = "0"
		process.env.KIMCHI_CODING_AGENT_DIR = join(envA, "harness")
		delete process.env.KIMCHI_ORIGINAL_CODING_AGENT_DIR

		vi.resetModules()
		await import("./env-root-init.js")
		const config = await import("./config.js")

		// The frozen agent dir is env b's, and a's pointer is preserved.
		expect(config.getAgentConfigDir()).toBe(join(home, ".config", "kimchi", "envs", "b", "harness"))
		expect(process.env.KIMCHI_CODING_AGENT_DIR).toBe(join(home, ".config", "kimchi", "envs", "b", "harness"))
		expect(process.env.KIMCHI_ORIGINAL_CODING_AGENT_DIR).toBe(join(envA, "harness"))
	})
})

/**
 * Entry-level wiring: run the real src/entry.ts under bun with a controlled
 * HOME and assert the filesystem effects (env tree creation / legacy in-place
 * use) and the invalid-name exit. The dev invocation mirrors the `dev` script
 * minus the proxy-helper make step.
 */
describe("entry.ts environment wiring", () => {
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

	it("KIMCHI_ENV=<name> routes the agent dir into envs/<name>/harness", () => {
		const home = tempHome()
		const result = runEntry(home, ["--version"], { KIMCHI_ENV: "foo" })
		expect(result.status, `stderr: ${result.stderr}`).toBe(0)
		expect(existsSync(join(home, ".config", "kimchi", "envs", "foo", "harness"))).toBe(true)
	})

	it("uses the legacy layout in place on a home that has one (no envs/ created)", () => {
		const home = tempHome()
		seedLegacyHome(home, "config")
		const result = runEntry(home, ["--version"])
		expect(result.status, `stderr: ${result.stderr}`).toBe(0)
		expect(existsSync(join(home, ".config", "kimchi", "config.json"))).toBe(true)
		expect(existsSync(join(home, ".config", "kimchi", "envs"))).toBe(false)
	})

	it("a bare run on a fresh home creates envs/default/", () => {
		const home = tempHome()
		const result = runEntry(home, ["--version"])
		expect(result.status, `stderr: ${result.stderr}`).toBe(0)
		expect(existsSync(join(home, ".config", "kimchi", "envs", "default", "harness"))).toBe(true)
	})

	it("`config set` under --env test writes envs/test/config.json", () => {
		const home = tempHome()
		const result = runEntry(home, ["--env", "test", "config", "set", "tui.timestamps", "on"])
		expect(result.status, `stderr: ${result.stderr}`).toBe(0)
		const configPath = join(home, ".config", "kimchi", "envs", "test", "config.json")
		expect(existsSync(configPath), `stdout: ${result.stdout}`).toBe(true)
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ tui: { timestamps: true } })
	})

	it("`config set` with no --env on a legacy home writes the legacy config.json", () => {
		const home = tempHome()
		seedLegacyHome(home, "config")
		const result = runEntry(home, ["config", "set", "tui.timestamps", "on"])
		expect(result.status, `stderr: ${result.stderr}`).toBe(0)
		const configPath = join(home, ".config", "kimchi", "config.json")
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ tui: { timestamps: true } })
		expect(existsSync(join(home, ".config", "kimchi", "envs"))).toBe(false)
	})

	it("exits with a clear error for --env ../evil", () => {
		const home = tempHome()
		const result = runEntry(home, ["--env", "../evil", "--version"])
		expect(result.status).not.toBe(0)
		expect(result.stderr).toMatch(/invalid environment name/)
	})
})
