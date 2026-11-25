import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { envBinaryPath, installTargetPath, packagedBinaryName, reExecTarget, resolveExecutablePath } from "./paths.js"

/**
 * Per-env version management: the env binary path derivation, the install
 * target selection, and the (pure) re-exec decision. The KIMCHI_ENV* vars
 * are scrubbed per test — the enclosing kimchi session exports them.
 */
const envKeys = ["KIMCHI_ENV", "KIMCHI_ENV_ROOT", "KIMCHI_ENV_LEGACY_DEFAULT"] as const
const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {}

beforeEach(() => {
	for (const key of envKeys) saved[key] = process.env[key]
})

afterEach(() => {
	for (const key of envKeys) {
		const value = saved[key]
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
})

describe("envBinaryPath", () => {
	it("returns <root>/bin/<binary> for a named env", () => {
		process.env.KIMCHI_ENV = "test"
		process.env.KIMCHI_ENV_ROOT = "/envs/test-root"
		process.env.KIMCHI_ENV_LEGACY_DEFAULT = "0"
		expect(envBinaryPath()).toBe(join("/envs/test-root", "bin", packagedBinaryName()))
	})

	it("returns undefined for the legacy default env", () => {
		process.env.KIMCHI_ENV = "default"
		process.env.KIMCHI_ENV_ROOT = "/legacy/root"
		process.env.KIMCHI_ENV_LEGACY_DEFAULT = "1"
		expect(envBinaryPath()).toBeUndefined()
	})

	it("returns undefined when no env was resolved (standalone use)", () => {
		for (const key of envKeys) delete process.env[key]
		expect(envBinaryPath()).toBeUndefined()
	})
})

describe("installTargetPath", () => {
	it("prefers an explicit override over the env binary", () => {
		process.env.KIMCHI_ENV = "test"
		process.env.KIMCHI_ENV_ROOT = "/envs/test-root"
		process.env.KIMCHI_ENV_LEGACY_DEFAULT = "0"
		expect(installTargetPath("/explicit/kimchi")).toBe("/explicit/kimchi")
	})

	it("installs into the env's own binary for a named env", () => {
		process.env.KIMCHI_ENV = "test"
		process.env.KIMCHI_ENV_ROOT = "/envs/test-root"
		process.env.KIMCHI_ENV_LEGACY_DEFAULT = "0"
		expect(installTargetPath()).toBe(join("/envs/test-root", "bin", packagedBinaryName()))
	})

	it("keeps the running executable in place for the legacy default and standalone use", () => {
		// Legacy default:
		process.env.KIMCHI_ENV = "default"
		process.env.KIMCHI_ENV_ROOT = "/legacy/root"
		process.env.KIMCHI_ENV_LEGACY_DEFAULT = "1"
		expect(installTargetPath()).toBe(resolveExecutablePath())
		// Standalone (no env resolved):
		for (const key of envKeys) delete process.env[key]
		expect(installTargetPath()).toBe(resolveExecutablePath())
	})
})

describe("reExecTarget", () => {
	let tmp: string

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "kimchi-reexec-test-"))
	})

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true })
	})

	function touch(path: string): string {
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, "x")
		return path
	}

	it("returns undefined without an env binary", () => {
		expect(reExecTarget(touch(join(tmp, "exec")), undefined)).toBeUndefined()
	})

	it("returns undefined when the env binary does not exist", () => {
		const exec = touch(join(tmp, "exec"))
		expect(reExecTarget(exec, join(tmp, "bin", "kimchi-missing"))).toBeUndefined()
	})

	it("returns the env binary when a different executable is running", () => {
		const exec = touch(join(tmp, "global", "kimchi"))
		const envBinary = touch(join(tmp, "envs", "test", "bin", packagedBinaryName()))
		// The resolved path is returned — spawn exactly what was stat'ed.
		expect(reExecTarget(exec, envBinary)).toBe(realpathSync(envBinary))
	})

	it("is loop-safe when the running process IS the env binary", () => {
		const envBinary = touch(join(tmp, "envs", "test", "bin", packagedBinaryName()))
		expect(reExecTarget(envBinary, envBinary)).toBeUndefined()
	})

	it("resolves symlinks: a symlinked env binary pointing at the running exec is not a target", () => {
		const exec = touch(join(tmp, "global", "kimchi"))
		const envBinary = join(tmp, "envs", "test", "bin", packagedBinaryName())
		mkdirSync(join(envBinary, ".."), { recursive: true })
		symlinkSync(exec, envBinary)
		expect(reExecTarget(exec, envBinary)).toBeUndefined()
	})

	it("returns undefined when the exec path cannot be resolved", () => {
		const envBinary = touch(join(tmp, "envs", "test", "bin", packagedBinaryName()))
		expect(reExecTarget(join(tmp, "does-not-exist"), envBinary)).toBeUndefined()
	})

	it("refuses to delegate to a group/world-writable env binary (implant guardrail)", () => {
		const exec = touch(join(tmp, "global", "kimchi"))
		const envBinary = touch(join(tmp, "envs", "test", "bin", packagedBinaryName()))
		chmodSync(envBinary, 0o666)
		expect(reExecTarget(exec, envBinary)).toBeUndefined()
	})

	it("delegates to a user-owned, non-writable env binary", () => {
		const exec = touch(join(tmp, "global", "kimchi"))
		const envBinary = touch(join(tmp, "envs", "test", "bin", packagedBinaryName()))
		chmodSync(envBinary, 0o755)
		expect(reExecTarget(exec, envBinary)).toBe(realpathSync(envBinary))
	})
})
