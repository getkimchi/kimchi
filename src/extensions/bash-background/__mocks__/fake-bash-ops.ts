/**
 * Shared fake `BashOperations` for background-bash tests.
 *
 * Captures an INDEPENDENT control surface per spawned exec (own promise,
 * own onData/signal) so cohorts of several concurrent processes behave
 * realistically. Tests drive each exec via `emitMatching`/`exitMatching`
 * (routed by command substring), or `emit`/`exit` for the most recently
 * started exec in single-process tests. `aborted()` reports whether ANY
 * exec's abort signal fired.
 *
 * NOTE: not a module-registry mock (no vi.mock) — tests import and inject
 * it directly via the `operations`/`registry` seams.
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent"

export interface FakeExec {
	command: string
	cwd: string
	env: NodeJS.ProcessEnv | undefined
	timeout: number | undefined
	signal: AbortSignal | undefined
	onData: (data: Buffer) => void
	aborted: boolean
}

export interface FakeOps extends BashOperations {
	/** Every exec started through this fake, in order. */
	started: FakeExec[]
	/** Resolve the MOST RECENT pending exec with an exit code. */
	exit(code: number | null): Promise<void>
	/** Resolve the exec whose command contains `needle` with an exit code. */
	exitMatching(needle: string, code: number | null): Promise<void>
	/** Emit output bytes to the MOST RECENT running exec. */
	emit(data: Buffer | string): void
	/** Emit output bytes to the exec whose command contains `needle`. */
	emitMatching(needle: string, data: Buffer | string): void
	/** True when ANY exec's abort signal has fired. */
	readonly aborted: boolean
	/** All exec instances (for per-exec assertions). */
	execs: FakeExec[]
}

interface LiveExec {
	exec: FakeExec
	settle: (r: { exitCode: number | null }) => void
	promise: Promise<{ exitCode: number | null }>
	settled: boolean
}

export function createFakeOps(_exitCode: number | null = 0): FakeOps {
	const started: FakeExec[] = []
	const live: LiveExec[] = []
	let anyAborted = false

	function findLive(needle?: string): LiveExec | undefined {
		const pending = live.filter((l) => !l.settled)
		if (needle === undefined) return pending[pending.length - 1]
		return pending.findLast((l) => l.exec.command.includes(needle))
	}

	const ops: FakeOps = {
		started,
		execs: started,
		async exit(code: number | null) {
			const target = findLive()
			if (!target) return
			target.settled = true
			target.settle({ exitCode: code })
			await target.promise
		},
		async exitMatching(needle: string, code: number | null) {
			const target = findLive(needle)
			if (!target) throw new Error(`no live fake exec matching ${needle}`)
			target.settled = true
			target.settle({ exitCode: code })
			await target.promise
		},
		emit(data: Buffer | string) {
			const buf = typeof data === "string" ? Buffer.from(data) : data
			findLive()?.exec.onData(buf)
		},
		emitMatching(needle: string, data: Buffer | string) {
			const buf = typeof data === "string" ? Buffer.from(data) : data
			const target = findLive(needle)
			if (!target) throw new Error(`no live fake exec matching ${needle}`)
			target.exec.onData(buf)
		},
		get aborted() {
			return anyAborted
		},
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			let settleExec: (r: { exitCode: number | null }) => void = () => {}
			let rejectExec: (err: Error) => void = () => {}
			const promise = new Promise<{ exitCode: number | null }>((resolve, reject) => {
				settleExec = resolve
				rejectExec = reject
			})
			const exec: FakeExec = { command, cwd, env, timeout, signal, onData, aborted: false }
			started.push(exec)
			const record: LiveExec = { exec, settle: settleExec, promise, settled: false }
			live.push(record)
			if (signal) {
				signal.addEventListener(
					"abort",
					() => {
						exec.aborted = true
						anyAborted = true
						record.settled = true
						// Mirror upstream: abort rejects the exec promise.
						rejectExec(new Error("aborted"))
					},
					{ once: true },
				)
			}
			return promise
		},
	}
	return ops
}
