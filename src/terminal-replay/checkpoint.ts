import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import type { IBufferCell } from "@xterm/headless"
import { resolveAuxiliaryFilesDir } from "../auxiliary-files/resolver.js"
import type { RecordingMetadata } from "./recorder.js"

/** A short-lived worker keeps part reconstruction off the terminal's event loop. */
export async function recordingCheckpointInWorker(directory: string, metadata: RecordingMetadata) {
	const staged = join(
		resolveAuxiliaryFilesDir(process.env, homedir(), process.execPath),
		"terminal-replay/checkpoint-worker.mjs",
	)
	const worker = new Worker(
		existsSync(staged)
			? staged
			: fileURLToPath(new URL("../../resources/terminal-replay/generated/checkpoint-worker.mjs", import.meta.url)),
		{ workerData: { directory, metadata } },
	)
	let timer: NodeJS.Timeout | undefined
	try {
		return await new Promise<Awaited<ReturnType<typeof recordingCheckpoint>>>((resolve, reject) => {
			worker.once("message", resolve)
			worker.once("error", reject)
			worker.once("exit", (code) => reject(new Error(`Recording checkpoint worker exited with code ${code}`)))
			timer = setTimeout(() => reject(new Error("Recording checkpoint worker timed out")), 30_000).unref()
			// Recording is best effort; a checkpoint must not keep the harness alive at shutdown.
			worker.unref()
		})
	} finally {
		clearTimeout(timer)
		await worker.terminate()
	}
}

function rendition(cell: IBufferCell): string {
	const codes = [0]
	for (const [enabled, code] of [
		[cell.isBold(), 1],
		[cell.isDim(), 2],
		[cell.isItalic(), 3],
		[cell.isUnderline(), 4],
		[cell.isBlink(), 5],
		[cell.isInverse(), 7],
		[cell.isInvisible(), 8],
		[cell.isStrikethrough(), 9],
		[cell.isOverline(), 53],
	]) {
		if (enabled) codes.push(code)
	}
	for (const [code, rgb, palette, color] of [
		[38, cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor()],
		[48, cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor()],
	] as const) {
		if (rgb) codes.push(code, 2, (color >>> 16) & 255, (color >>> 8) & 255, color & 255)
		else if (palette) codes.push(code, 5, color)
	}
	return `\x1b[${codes.join(";")}m`
}

function unfinishedEscape(text: string): string {
	const start = text.lastIndexOf("\x1b")
	if (start < 0) return ""
	const tail = text.slice(start)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI cancellation and string terminator bytes.
	if (/[\x18\x1a\x9c]/.test(tail)) return ""
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI string sequence introducers.
	if (/^\x1b[\]P_X^]/.test(tail)) {
		return tail[1] === "]" && tail.includes("\x07") ? "" : tail
	}
	// Other C0 controls execute immediately and must not execute again in the next part.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Deliberately match terminal control bytes.
	const sequence = tail.replace(/[\x00-\x1a\x1c-\x1f\x7f]/g, "")
	// biome-ignore lint/suspicious/noControlCharactersInRegex: An incomplete ANSI escape sequence.
	return /^\x1b(?:\[[0-?]*[ -/]*|[ -/]*)$/.test(sequence) ? sequence : ""
}

/** Reconstruct only at a part boundary; ordinary capture never runs a second terminal. */
export async function recordingCheckpoint(chunks: AsyncIterable<Buffer>, cols: number, rows: number) {
	const [{ Terminal }, { SerializeAddon }, { Unicode11Addon }] = await Promise.all([
		import("@xterm/headless"),
		import("@xterm/addon-serialize"),
		import("@xterm/addon-unicode11"),
	])
	const terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
	terminal.loadAddon(new Unicode11Addon())
	terminal.unicode.activeVersion = "11"
	const serializer = new SerializeAddon()
	terminal.loadAddon(serializer)
	let cursorVisible = true
	let cursorStyle = 0
	let pending = ""
	terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
		const value = params[0] ?? 1
		if (typeof value === "number" && value >= 0 && value <= 6) cursorStyle = value
		return false
	})
	const resetCursor = () => {
		cursorStyle = 0
		cursorVisible = true
		return false
	}
	terminal.parser.registerEscHandler({ final: "c" }, resetCursor)
	terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, resetCursor)
	for (const final of ["h", "l"]) {
		terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
			if (params.flat().includes(25)) cursorVisible = final === "h"
			return false
		})
	}
	const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve))
	try {
		for await (const chunk of chunks) {
			let output = ""
			for (const line of chunk.toString("utf8").trimEnd().split("\n")) {
				const event = JSON.parse(line)
				if (!Array.isArray(event)) continue
				if (event[1] === "o") {
					output += event[2]
					pending = unfinishedEscape(pending + event[2])
				} else if (event[1] === "r") {
					if (output) await write(output)
					output = ""
					const [width, height] = event[2].split("x").map(Number)
					terminal.resize(width, height)
				}
			}
			if (output) await write(output)
		}
		let data = serializer.serialize({ scrollback: 0 })
		const buffer = terminal.buffer.active
		if (buffer.cursorX === terminal.cols) {
			// SerializeAddon cannot position one past the last column with CSI C.
			// Reprinting that cell restores pending wrap; SGR keeps it armed.
			const line = buffer.getLine(buffer.baseY + buffer.cursorY)
			let col = terminal.cols - 1
			let cell = line?.getCell(col)
			if (cell?.getWidth() === 0) cell = line?.getCell(--col)
			if (!cell) throw new Error("Cannot read pending-wrap checkpoint cell")
			const repair = `\r${col ? `\x1b[${col}C` : ""}${rendition(cell)}${cell.getChars() || " "}`
			// The captured screen is already serialized; use a disposable cell to read
			// the current attributes, which can differ from the last printed cell.
			await write("\x18X")
			const current = buffer.getLine(buffer.baseY + buffer.cursorY)?.getCell(buffer.cursorX - 1)
			if (!current) throw new Error("Cannot read checkpoint cursor attributes")
			data += repair + rendition(current)
		}
		return {
			data: `${data}\x1b[${cursorStyle} q\x1b[?25${cursorVisible ? "h" : "l"}${pending}`,
			cols: terminal.cols,
			rows: terminal.rows,
		}
	} finally {
		terminal.dispose()
	}
}
