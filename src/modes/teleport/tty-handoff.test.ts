import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type SpawnLike, runChildWithTTYHandoff } from "./tty-handoff.js"

class FakeChild extends EventEmitter {
	kill = vi.fn()
}

interface SpawnCall {
	cmd: string
	args: readonly string[]
	options: Parameters<SpawnLike>[2]
	child: FakeChild
}

function makeSpawner() {
	const calls: SpawnCall[] = []
	const spawner: SpawnLike = (cmd, args, options) => {
		const child = new FakeChild()
		calls.push({ cmd, args, options, child })
		return child as unknown as ReturnType<SpawnLike>
	}
	return { spawner, calls }
}

let originalIsRaw: boolean | undefined
let setRawSpy: ReturnType<typeof vi.fn>
let pauseSpy: ReturnType<typeof vi.fn>
let resumeSpy: ReturnType<typeof vi.fn>
let writeSpy: ReturnType<typeof vi.fn>
let killSpy: ReturnType<typeof vi.fn>
let originalWrite: typeof process.stdout.write
let originalKill: typeof process.kill

beforeEach(() => {
	originalIsRaw = (process.stdin as { isRaw?: boolean }).isRaw
	;(process.stdin as { isRaw?: boolean }).isRaw = true

	setRawSpy = vi.fn()
	;(process.stdin as { setRawMode?: (mode: boolean) => void }).setRawMode = setRawSpy

	pauseSpy = vi.fn().mockReturnValue(process.stdin)
	resumeSpy = vi.fn().mockReturnValue(process.stdin)
	;(process.stdin as unknown as { pause: () => unknown }).pause = pauseSpy
	;(process.stdin as unknown as { resume: () => unknown }).resume = resumeSpy

	originalWrite = process.stdout.write.bind(process.stdout)
	writeSpy = vi.fn(() => true)
	;(process.stdout as unknown as { write: (...a: unknown[]) => unknown }).write = writeSpy

	originalKill = process.kill
	killSpy = vi.fn(() => true)
	;(process as unknown as { kill: (...a: unknown[]) => unknown }).kill = killSpy
})

afterEach(() => {
	;(process.stdin as { isRaw?: boolean }).isRaw = originalIsRaw
	;(process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite
	;(process as unknown as { kill: typeof process.kill }).kill = originalKill
	vi.restoreAllMocks()
})

describe("runChildWithTTYHandoff", () => {
	it("spawns the child with stdio:inherit and the supplied env", async () => {
		const { spawner, calls } = makeSpawner()
		const promise = runChildWithTTYHandoff({
			cmd: "ssh",
			args: ["-p", "443", "sandbox@host"],
			env: { AUTH_TOKEN: "tok-xyz", PATH: "/usr/bin" },
			_spawn: spawner,
		})
		expect(calls).toHaveLength(1)
		expect(calls[0].cmd).toBe("ssh")
		expect(calls[0].args).toEqual(["-p", "443", "sandbox@host"])
		expect(calls[0].options.stdio).toBe("inherit")
		expect((calls[0].options.env as NodeJS.ProcessEnv).AUTH_TOKEN).toBe("tok-xyz")

		calls[0].child.emit("exit", 0, null)
		await expect(promise).resolves.toBe(0)
	})

	it("returns the child's exit code", async () => {
		const { spawner, calls } = makeSpawner()
		const promise = runChildWithTTYHandoff({ cmd: "ssh", args: [], _spawn: spawner })
		calls[0].child.emit("exit", 42, null)
		await expect(promise).resolves.toBe(42)
	})

	it("returns 128 when the child is killed by a signal", async () => {
		const { spawner, calls } = makeSpawner()
		const promise = runChildWithTTYHandoff({ cmd: "ssh", args: [], _spawn: spawner })
		calls[0].child.emit("exit", null, "SIGTERM")
		await expect(promise).resolves.toBe(128)
	})

	it("rejects on child error", async () => {
		const { spawner, calls } = makeSpawner()
		const promise = runChildWithTTYHandoff({ cmd: "ssh", args: [], _spawn: spawner })
		calls[0].child.emit("error", new Error("ENOENT"))
		await expect(promise).rejects.toThrow(/ENOENT/)
	})

	it("drops raw mode before spawn and restores it after exit", async () => {
		const { spawner, calls } = makeSpawner()
		const promise = runChildWithTTYHandoff({ cmd: "ssh", args: [], _spawn: spawner })

		// First call: drop raw mode (false).
		expect(setRawSpy).toHaveBeenNthCalledWith(1, false)
		expect(pauseSpy).toHaveBeenCalled()

		calls[0].child.emit("exit", 0, null)
		await promise

		// Second call: restore raw mode (true).
		expect(setRawSpy).toHaveBeenNthCalledWith(2, true)
		expect(resumeSpy).toHaveBeenCalled()
	})

	it("emits SIGWINCH after the child exits to nudge a redraw", async () => {
		const { spawner, calls } = makeSpawner()
		const promise = runChildWithTTYHandoff({ cmd: "ssh", args: [], _spawn: spawner })
		calls[0].child.emit("exit", 0, null)
		await promise
		expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGWINCH")
	})

	it("kills the child when the abort signal fires", async () => {
		const ctrl = new AbortController()
		const { spawner, calls } = makeSpawner()
		const promise = runChildWithTTYHandoff({ cmd: "ssh", args: [], signal: ctrl.signal, _spawn: spawner })

		ctrl.abort()
		expect(calls[0].child.kill).toHaveBeenCalledWith("SIGTERM")

		calls[0].child.emit("exit", null, "SIGTERM")
		await expect(promise).resolves.toBe(128)
	})

	it("disables pi-tui modes before the child and re-enables them after", async () => {
		const { spawner, calls } = makeSpawner()
		const promise = runChildWithTTYHandoff({ cmd: "ssh", args: [], _spawn: spawner })

		// Pre-spawn teardown: bracketed-paste off, kitty pop, modifyOtherKeys off, cursor shown.
		const preCalls = writeSpy.mock.calls.flat().join("")
		expect(preCalls).toContain("\x1b[?2004l")
		expect(preCalls).toContain("\x1b[<u")
		expect(preCalls).toContain("\x1b[>4;0m")
		expect(preCalls).toContain("\x1b[?25h")

		calls[0].child.emit("exit", 0, null)
		await promise

		// Post-spawn restore: bracketed-paste on, kitty push, cursor hidden.
		const allCalls = writeSpy.mock.calls.flat().join("")
		expect(allCalls).toContain("\x1b[?2004h")
		expect(allCalls).toContain("\x1b[>7u")
		expect(allCalls).toContain("\x1b[?25l")
	})

	it("enters and leaves the alternate screen buffer around the child", async () => {
		const { spawner, calls } = makeSpawner()
		const promise = runChildWithTTYHandoff({ cmd: "ssh", args: [], _spawn: spawner })

		const preCalls = writeSpy.mock.calls.flat().join("")
		expect(preCalls).toContain("\x1b[?1049h")
		expect(preCalls).not.toContain("\x1b[?1049l")

		calls[0].child.emit("exit", 0, null)
		await promise

		const allCalls = writeSpy.mock.calls.flat().join("")
		expect(allCalls).toContain("\x1b[?1049l")
		// Order matters: the leave must come after the enter.
		expect(allCalls.indexOf("\x1b[?1049l")).toBeGreaterThan(allCalls.indexOf("\x1b[?1049h"))
	})
})
