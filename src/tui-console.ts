import { Console } from "node:console"
import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Writable } from "node:stream"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { ProcessTerminal } from "@earendil-works/pi-tui"

const MAX_LOG_BYTES = 1024 * 1024
let uninstall: (() => void) | undefined
// Resolved once per installation; getAgentDir() is not safe to call per line
// (any log emitted from its own dependencies would feed back into this file).
let logPath: string | undefined
let writingDiagnostic = false

function writeDiagnostic(chunk: Buffer): void {
	try {
		logPath ??= join(getAgentDir(), "logs", "tui.log")
		const path = logPath
		const data = Buffer.concat([Buffer.from(`${new Date().toISOString()} ${process.pid} `), chunk]).subarray(
			-MAX_LOG_BYTES,
		)
		// ponytail: one shared log; simultaneous writers may briefly exceed the rotation threshold.
		// Other processes rotate and delete this file too, so its size is re-read per line.
		let size = 0
		try {
			size = statSync(path).size
		} catch {
			// ENOENT (missing log or logs dir) / ENOTDIR (a file blocks "logs") → treat as empty.
		}
		const full = size + data.length > MAX_LOG_BYTES
		try {
			writeFileSync(path, data, { flag: full ? "w" : "a", mode: 0o600 })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
			writeFileSync(path, data, { flag: full ? "w" : "a", mode: 0o600 })
		}
	} catch {
		// Logging must neither interrupt the session nor fall back to the live terminal.
	}
}

/** Keep third-party console output off the screen only while Pi owns the terminal. */
export function installTuiConsoleLogging(): () => void {
	if (uninstall) return uninstall
	const prototype = ProcessTerminal.prototype
	const { start, stop } = prototype
	const active = new Set<ProcessTerminal>()
	let previousConsole: typeof console | undefined
	const sink = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			writingDiagnostic = true
			try {
				writeDiagnostic(chunk)
			} finally {
				writingDiagnostic = false
			}
			callback()
		},
	})
	// Writes arriving while the logger is mid-write come from code inside the logger's
	// own dependencies. Node buffers writes made during _write and replays them after,
	// so they must be dropped at the entry, before they reach the buffer.
	const sinkWrite = sink.write.bind(sink)
	sink.write = (chunk: unknown, ...rest: unknown[]) => {
		if (writingDiagnostic) return true
		return (sinkWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
	}
	const diagnosticConsole = new Console({ stdout: sink, stderr: sink, colorMode: false })
	const release = (terminal: ProcessTerminal): void => {
		active.delete(terminal)
		if (active.size === 0 && previousConsole) {
			globalThis.console = previousConsole
			previousConsole = undefined
		}
	}
	prototype.start = function (...args) {
		if (active.size === 0) {
			previousConsole = globalThis.console
			globalThis.console = diagnosticConsole
		}
		active.add(this)
		try {
			return start.apply(this, args)
		} catch (error) {
			release(this)
			throw error
		}
	}
	prototype.stop = function () {
		try {
			return stop.call(this)
		} finally {
			release(this)
		}
	}

	uninstall = () => {
		prototype.start = start
		prototype.stop = stop
		if (previousConsole) globalThis.console = previousConsole
		active.clear()
		sink.end()
		logPath = undefined
		uninstall = undefined
	}
	return uninstall
}
