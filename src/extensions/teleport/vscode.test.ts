import type { ChildProcess, SpawnOptions, SpawnSyncOptions, SpawnSyncReturns } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { isVsCodeAvailable, launchVsCodeRemote, type VsCodeInternals } from "./vscode.js"

type SpawnSyncLike = NonNullable<VsCodeInternals["_spawnSync"]>
type SpawnLike = NonNullable<VsCodeInternals["_spawn"]>

/** Minimal fake spawnSync that records the call and returns a fixed status. */
function makeSpawnSync(status: number | null = 0): {
	fn: SpawnSyncLike
	calls: { args: string[]; opts: SpawnSyncOptions }[]
} {
	const calls: { args: string[]; opts: SpawnSyncOptions }[] = []
	const fn = ((_cmd: string, args: string[], opts: SpawnSyncOptions) => {
		calls.push({ args, opts })
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
function makeSpawn(): { fn: SpawnLike; calls: { args: string[]; opts: SpawnOptions }[]; child: ChildProcess } {
	const calls: { args: string[]; opts: SpawnOptions }[] = []
	const child = Object.assign(new EventEmitter(), {
		pid: 123,
		stdout: null,
		stderr: null,
		stdin: null,
		unref: vi.fn(),
		kill: vi.fn(),
	}) as unknown as ChildProcess
	const fn = ((_cmd: string, args: string[], opts: SpawnOptions) => {
		calls.push({ args, opts })
		return child
	}) as unknown as SpawnLike
	return { fn, calls, child }
}

describe("isVsCodeAvailable", () => {
	it("returns true when `code --version` exits 0", () => {
		const { fn, calls } = makeSpawnSync(0)
		expect(isVsCodeAvailable({ _spawnSync: fn })).toBe(true)
		expect(calls[0]?.args).toEqual(["--version"])
		expect(calls[0]?.opts.shell).toBe(true)
		expect(calls[0]?.opts.stdio).toBe("ignore")
	})

	it("returns false when `code --version` exits non-zero", () => {
		const { fn } = makeSpawnSync(127)
		expect(isVsCodeAvailable({ _spawnSync: fn })).toBe(false)
	})

	it("returns false when spawnSync throws", () => {
		const fn = (() => {
			throw new Error("ENOENT")
		}) as unknown as SpawnSyncLike
		expect(isVsCodeAvailable({ _spawnSync: fn })).toBe(false)
	})
})

describe("launchVsCodeRemote", () => {
	it("spawns `code --remote ssh-remote+<alias> <remotePath>` detached", () => {
		const { fn, calls } = makeSpawn()
		launchVsCodeRemote("kimchi-alpha", "/home/sandbox/", { _spawn: fn })
		expect(calls[0]?.args).toEqual(["--remote", "ssh-remote+kimchi-alpha", "/home/sandbox/"])
	})

	it("detaches the child and unrefs it so kimchi keeps running", () => {
		const { fn, calls, child } = makeSpawn()
		launchVsCodeRemote("kimchi-alpha", "/home/sandbox/", { _spawn: fn })
		expect(calls[0]?.opts.detached).toBe(true)
		expect(calls[0]?.opts.stdio).toBe("ignore")
		expect(vi.mocked(child.unref)).toHaveBeenCalled()
	})
})
