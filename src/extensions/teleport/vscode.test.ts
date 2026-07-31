import type { ChildProcess, SpawnOptions, SpawnSyncOptions, SpawnSyncReturns } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { isVsCodeAvailable, launchVsCodeRemote, resolveVsCodeCommand, type VsCodeInternals } from "./vscode.js"

type SpawnSyncLike = NonNullable<VsCodeInternals["_spawnSync"]>
type SpawnLike = NonNullable<VsCodeInternals["_spawn"]>

/** Minimal fake spawnSync that records the call and returns a fixed status. */
function makeSpawnSync(status: number | null = 0): {
	fn: SpawnSyncLike
	calls: { cmd: string; args: string[]; opts: SpawnSyncOptions }[]
} {
	const calls: { cmd: string; args: string[]; opts: SpawnSyncOptions }[] = []
	const fn = ((cmd: string, args: string[], opts: SpawnSyncOptions) => {
		calls.push({ cmd, args, opts })
		const result: SpawnSyncReturns<Buffer | string> = {
			status,
			signal: null,
			stdout: "",
			stderr: "",
			pid: 0,
			output: [],
		}
		return result
	}) as unknown as SpawnSyncLike
	return { fn, calls }
}

/** Minimal fake spawn returning a ChildProcess-like stub with unref(). */
function makeSpawn(): {
	fn: SpawnLike
	calls: { cmd: string; args: string[]; opts: SpawnOptions }[]
	child: ChildProcess
} {
	const calls: { cmd: string; args: string[]; opts: SpawnOptions }[] = []
	const child = Object.assign(new EventEmitter(), {
		pid: 123,
		stdout: null,
		stderr: null,
		stdin: null,
		unref: vi.fn(),
		kill: vi.fn(),
	}) as unknown as ChildProcess
	const fn = ((cmd: string, args: string[], opts: SpawnOptions) => {
		calls.push({ cmd, args, opts })
		return child
	}) as unknown as SpawnLike
	return { fn, calls, child }
}

describe("resolveVsCodeCommand", () => {
	it("returns 'code' when `code --version` exits 0", () => {
		const { fn, calls } = makeSpawnSync(0)
		expect(resolveVsCodeCommand({ _spawnSync: fn })).toBe("code")
		expect(calls[0]?.cmd).toBe("code")
		expect(calls[0]?.args).toEqual(["--version"])
		expect(calls[0]?.opts.shell).toBe(true)
		expect(calls[0]?.opts.stdio).toBe("ignore")
	})

	it("falls back to 'code-insiders' when `code` exits non-zero", () => {
		const { calls } = makeSpawnSync(0)
		// First call (code) fails, second (code-insiders) succeeds.
		let i = 0
		const wrapped = ((cmd: string, args: string[], opts: SpawnSyncOptions) => {
			const result: SpawnSyncReturns<Buffer | string> = {
				status: i === 0 ? 127 : 0,
				signal: null,
				stdout: "",
				stderr: "",
				pid: 0,
				output: [],
			}
			calls.push({ cmd, args, opts })
			i++
			return result
		}) as unknown as SpawnSyncLike
		expect(resolveVsCodeCommand({ _spawnSync: wrapped })).toBe("code-insiders")
		expect(calls.map((c) => c.cmd)).toEqual(["code", "code-insiders"])
	})

	it("falls back to 'code-insiders' when `code` throws", () => {
		const { calls } = makeSpawnSync(0)
		let i = 0
		const wrapped = ((cmd: string, args: string[], opts: SpawnSyncOptions) => {
			calls.push({ cmd, args, opts })
			if (i === 0) {
				i++
				throw new Error("ENOENT")
			}
			const result: SpawnSyncReturns<Buffer | string> = {
				status: 0,
				signal: null,
				stdout: "",
				stderr: "",
				pid: 0,
				output: [],
			}
			i++
			return result
		}) as unknown as SpawnSyncLike
		expect(resolveVsCodeCommand({ _spawnSync: wrapped })).toBe("code-insiders")
		expect(calls.map((c) => c.cmd)).toEqual(["code", "code-insiders"])
	})

	it("returns null when both `code` and `code-insiders` are missing", () => {
		const { fn } = makeSpawnSync(127)
		expect(resolveVsCodeCommand({ _spawnSync: fn })).toBeNull()
	})

	it("returns null when both `code` and `code-insiders` throw", () => {
		const fn = (() => {
			throw new Error("ENOENT")
		}) as unknown as SpawnSyncLike
		expect(resolveVsCodeCommand({ _spawnSync: fn })).toBeNull()
	})
})

describe("isVsCodeAvailable", () => {
	it("returns true when `code --version` exits 0", () => {
		const { fn } = makeSpawnSync(0)
		expect(isVsCodeAvailable({ _spawnSync: fn })).toBe(true)
	})

	it("returns true when `code` is missing but `code-insiders` exits 0", () => {
		let i = 0
		const fn = (() => {
			const result: SpawnSyncReturns<Buffer | string> = {
				status: i === 0 ? 127 : 0,
				signal: null,
				stdout: "",
				stderr: "",
				pid: 0,
				output: [],
			}
			i++
			return result
		}) as unknown as SpawnSyncLike
		expect(isVsCodeAvailable({ _spawnSync: fn })).toBe(true)
	})

	it("returns false when both `code` and `code-insiders` exit non-zero", () => {
		const { fn } = makeSpawnSync(127)
		expect(isVsCodeAvailable({ _spawnSync: fn })).toBe(false)
	})

	it("returns false when spawnSync throws for both candidates", () => {
		const fn = (() => {
			throw new Error("ENOENT")
		}) as unknown as SpawnSyncLike
		expect(isVsCodeAvailable({ _spawnSync: fn })).toBe(false)
	})
})

describe("launchVsCodeRemote", () => {
	it("spawns `<command> --remote ssh-remote+<alias> <remotePath>` detached", () => {
		const { fn, calls } = makeSpawn()
		launchVsCodeRemote("code", "kimchi-alpha", "/home/sandbox/", { _spawn: fn })
		expect(calls[0]?.cmd).toBe("code")
		expect(calls[0]?.args).toEqual(["--remote", "ssh-remote+kimchi-alpha", "/home/sandbox/"])
	})

	it("spawns `code-insiders` when that is the resolved command", () => {
		const { fn, calls } = makeSpawn()
		launchVsCodeRemote("code-insiders", "kimchi-beta", "/home/sandbox/", { _spawn: fn })
		expect(calls[0]?.cmd).toBe("code-insiders")
		expect(calls[0]?.args).toEqual(["--remote", "ssh-remote+kimchi-beta", "/home/sandbox/"])
	})

	it("detaches the child and unrefs it so kimchi keeps running", () => {
		const { fn, calls, child } = makeSpawn()
		launchVsCodeRemote("code", "kimchi-alpha", "/home/sandbox/", { _spawn: fn })
		expect(calls[0]?.opts.detached).toBe(true)
		expect(calls[0]?.opts.stdio).toBe("ignore")
		expect(vi.mocked(child.unref)).toHaveBeenCalled()
	})
})
