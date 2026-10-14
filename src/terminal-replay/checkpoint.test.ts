import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { Terminal } from "@xterm/headless"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { recordingCheckpoint, recordingCheckpointInWorker } from "./checkpoint.js"
import type { RecordingMetadata } from "./recorder.js"

let directory: string
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "kimchi-checkpoint-"))
	await mkdir(join(directory, "terminal-replay"))
	execFileSync("bun", [
		"build",
		"src/terminal-replay/checkpoint-worker.ts",
		"--target=node",
		"--format=esm",
		"--minify",
		"--outfile",
		join(directory, "terminal-replay/checkpoint-worker.mjs"),
	])
})
afterEach(() => {
	vi.unstubAllEnvs()
	vi.useRealTimers()
})
afterAll(async () => rm(directory, { recursive: true, force: true }))

async function fixture(data: string) {
	const part = await mkdtemp(join(directory, "part-"))
	const compressed = gzipSync(data)
	const prefix = Buffer.alloc(4)
	prefix.writeUInt32BE(compressed.length)
	await writeFile(join(part, "output.bin"), Buffer.concat([prefix, compressed]))
	const metadata: RecordingMetadata = {
		version: 1,
		id: "checkpoint",
		sessionId: "checkpoint",
		pid: process.pid,
		startedAt: new Date(0).toISOString(),
		status: "recording",
		cols: 20,
		rows: 6,
		chunks: 1,
		rawBytes: Buffer.byteLength(data),
		compressedBytes: compressed.length + 4,
		queueHighWaterBytes: 0,
		duration: 0,
	}
	return { part, metadata }
}

async function screen(data: string) {
	const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true, scrollback: 0 })
	terminal.loadAddon(new Unicode11Addon())
	terminal.unicode.activeVersion = "11"
	let visible = true
	let cursorStyle = 0
	terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
		const value = params[0] ?? 1
		if (typeof value === "number" && value >= 0 && value <= 6) cursorStyle = value
		return false
	})
	const resetCursor = () => {
		cursorStyle = 0
		visible = true
		return false
	}
	terminal.parser.registerEscHandler({ final: "c" }, resetCursor)
	terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, resetCursor)
	for (const final of ["h", "l"]) {
		terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
			if (params.flat().includes(25)) visible = final === "h"
			return false
		})
	}
	try {
		await new Promise<void>((resolve) => terminal.write(data, resolve))
		const buffer = terminal.buffer.active
		return {
			rows: Array.from({ length: 6 }, (_, row) =>
				Array.from({ length: 20 }, (_, col) => {
					const cell = buffer.getLine(buffer.baseY + row)?.getCell(col)
					return [
						cell?.getChars(),
						cell?.getFgColor(),
						cell?.getBgColor(),
						cell?.getWidth(),
						cell?.isBold(),
						cell?.isDim(),
						cell?.isItalic(),
						cell?.isUnderline(),
						cell?.isInverse(),
					]
				}),
			),
			cursor: [buffer.cursorX, buffer.cursorY, visible],
			cursorStyle,
			wrapped: Array.from({ length: 6 }, (_, row) => buffer.getLine(buffer.baseY + row)?.isWrapped),
			buffer: buffer.type,
		}
	} finally {
		terminal.dispose()
	}
}

describe.each(["in-process", "worker"])("recording checkpoints (%s)", (mode) => {
	it.each([
		["colours, wide characters and cursor", "\x1b[2;3H\x1b[38;2;255;0;0m界RED", " NEXT"],
		["modern emoji wrapping and overwrite", "\x1b[2;18H🧑AB\x1b[2;20HX", "!"],
		["pending wrap on an earlier row", "\x1b[4;1HLATER\x1b[2;20HX", "!"],
		[
			"pending wrap with distinct cell and current styles",
			"\x1b[4;1HLATER\x1b[2;20H\x1b[1;3;4;38;2;255;20;0;48;5;42mX\x1b[0;2;7;32;44m",
			"!",
		],
		["pending wrap after a wide combining character", "\x1b[4;1HLATER\x1b[2;19H🧑\u0301", "!"],
		["pending wrap on the bottom row of the alternate screen", "\x1b[?1049h\x1b[6;20HX\x1b[31m", "!"],
		["pending wrap with a split colour sequence", "\x1b[2;20HX\x1b[38;2;255;", "0;0m!"],
		["pending wrap with a split window title", "\x1b[2;20HX\x1b]0;unfinished ", "title\x07!"],
		["pending wrap with wrapping disabled", "\x1b[4;1HLATER\x1b[?7l\x1b[2;20HX\x1b[32m", "!"],
		["alternate screen and hidden cursor", "\x1b[?1049h\x1b[?25l\x1b[2;1HDUPLICATE\x1b[3;1HDUPLICATE", "!"],
		["cursor shape", "\x1b[6 qbefore", "\x1b[4 q!"],
		["cursor shape and visibility after reset", "\x1b[6 q\x1b[?25l\x1b[!pbefore", "\x1b[4 q\x1bc!"],
		["split colour sequence", "before\x1b[38;2;255;", "0;0mAFTER"],
		["split window title", "before\x1b]0;unfinished ", "title\x07AFTER"],
	])("preserves %s across parts", async (_name, before, after) => {
		const data = `${JSON.stringify([0, "o", before])}\n`
		async function* chunks() {
			yield Buffer.from(data)
		}
		const { part, metadata } = await fixture(data)
		vi.stubEnv("PI_PACKAGE_DIR", directory)
		const checkpoint =
			mode === "worker" ? await recordingCheckpointInWorker(part, metadata) : await recordingCheckpoint(chunks(), 20, 6)
		expect(await screen(checkpoint.data)).toEqual(await screen(before))
		expect(await screen(checkpoint.data + after)).toEqual(await screen(before + after))
	})
})

describe("checkpoint worker lifecycle", () => {
	it("keeps resize events and committed-chunk limits", async () => {
		vi.stubEnv("PI_PACKAGE_DIR", directory)
		const { part, metadata } = await fixture('[0,"r","40x10"]\n[0,"o","RESIZED"]\n')
		const checkpoint = await recordingCheckpointInWorker(part, metadata)
		expect(checkpoint).toMatchObject({ cols: 40, rows: 10 })
		expect(checkpoint.data).toContain("RESIZED")
		await expect(recordingCheckpointInWorker(part, { ...metadata, rawBytes: 32 * 1024 * 1024 + 1 })).rejects.toThrow(
			"Recording exceeds its limit",
		)
	})

	it("rejects damaged input without blocking later checkpoints", async () => {
		vi.stubEnv("PI_PACKAGE_DIR", directory)
		const { part, metadata } = await fixture("not JSON\n")
		await expect(recordingCheckpointInWorker(part, metadata)).rejects.toThrow()
		const valid = await fixture(`${JSON.stringify([0, "o", "RECOVERED"])}\n`)
		expect((await recordingCheckpointInWorker(valid.part, valid.metadata)).data).toContain("RECOVERED")
	})

	it("terminates a stalled worker at the deadline", async () => {
		const stalled = await mkdtemp(join(directory, "stalled-"))
		await mkdir(join(stalled, "terminal-replay"))
		await writeFile(join(stalled, "terminal-replay/checkpoint-worker.mjs"), "while (true) {}")
		vi.stubEnv("PI_PACKAGE_DIR", stalled)
		const { part, metadata } = await fixture("{}\n")
		vi.useFakeTimers()
		const rejected = expect(recordingCheckpointInWorker(part, metadata)).rejects.toThrow("timed out")
		await vi.advanceTimersByTimeAsync(30_000)
		await rejected
	})
})
