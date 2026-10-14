import { Console } from "node:console"
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Writable } from "node:stream"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { ProcessTerminal } from "@earendil-works/pi-tui"

const MAX_LOG_BYTES = 1024 * 1024
let uninstall: (() => void) | undefined

function writeDiagnostic(chunk: Buffer): void {
	try {
		const directory = join(getAgentDir(), "logs")
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		const path = join(directory, "tui.log")
		const data = Buffer.concat([Buffer.from(`${new Date().toISOString()} ${process.pid} `), chunk]).subarray(
			-MAX_LOG_BYTES,
		)
		// ponytail: one shared log; simultaneous writers may briefly exceed the rotation threshold.
		// Use per-process logs if concurrent diagnostic volume makes that material.
		const full = existsSync(path) && statSync(path).size + data.length > MAX_LOG_BYTES
		writeFileSync(path, data, { flag: full ? "w" : "a", mode: 0o600 })
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
			writeDiagnostic(chunk)
			callback()
		},
	})
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
		uninstall = undefined
	}
	return uninstall
}
