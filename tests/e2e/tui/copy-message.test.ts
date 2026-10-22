/**
 * TUI E2E for the message-copy path: a copied message must paste
 * clean at any terminal width — the copy path must not carry the terminal's
 * hard wrap.
 *
 * Pi ships the copy implementation; these tests verify the wiring survives
 * inside Kimchi:
 *   - `/copy` copies the raw last assistant message (no rendered breaks)
 *   - Ctrl+X (`app.message.copy`) reaches Pi's handler and is not shadowed
 *     by Kimchi's background-agent kill binding (the agents extension only
 *     consumes Ctrl+X while a background agent is running)
 *   - fullscreen Ctrl+X copies the raw message too
 *   - a partial mouse selection spanning a soft wrap rejoins without hard
 *     breaks (soft-wrap glue is tracked through the pi-tui render pipeline
 *     via patches/@earendil-works__pi-tui@1.3.0.patch)
 *
 * Clipboard capture: darwin reads the real pasteboard via pbpaste (saved and
 * restored around the test); linux seeds a `wl-copy` shim onto PATH with
 * WAYLAND_DISPLAY set so Pi's clipboard-command path writes into a file.
 */

import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { expect, Shell, test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const notWindows = process.platform === "win32" ? test.skip : test

// A single long paragraph with no newlines: unique tokens make wrap fragments
// greppable and keep the expected clipboard payload exact. 72 tokens wrap to
// three rows at the shared 120-column harness geometry.
const TOKENS = Array.from({ length: 72 }, (_, i) => `t${String(i + 1).padStart(2, "0")}`)
const REPLY = TOKENS.join(" ")
const PROMPT = "say the tokens"

const RESPONSES = [{ stream: [REPLY] }]

type Probe = () => string

interface ClipboardProbe {
	read: Probe
	writeSentinel(value: string): void
}

function clipboardProbe(homeDir: string): ClipboardProbe {
	if (process.platform === "darwin") {
		return {
			read: () => execFileSync("pbpaste", [], { encoding: "utf-8" }),
			writeSentinel: (value) => execFileSync("pbcopy", [], { input: value, encoding: "utf-8" }),
		}
	}
	// linux: capture file written by the seeded wl-copy shim
	const captureFile = join(homeDir, "clipboard-capture.txt")
	return {
		read: () => readFileSync(captureFile, "utf-8").replaceAll("\r", ""),
		writeSentinel: (value) => writeFileSync(captureFile, value, "utf-8"),
	}
}

/** Poll the clipboard until it holds `expected` (or throw with the last seen content). */
async function waitForClipboard(probe: ClipboardProbe, expected: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	let lastSeen = ""
	while (Date.now() < deadline) {
		try {
			lastSeen = probe.read()
			if (lastSeen === expected) return
		} catch {
			// capture file may not exist yet on linux
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(
		`Timed out waiting for clipboard.\nExpected (${expected.length} chars): ${JSON.stringify(expected.slice(0, 100))}…\nLast seen (${lastSeen.length} chars): ${JSON.stringify(lastSeen.slice(0, 240))}`,
	)
}

/** Save and restore the macOS pasteboard around a test (linux capture needs no restore). */
async function withClipboardSaved(body: () => Promise<void>): Promise<void> {
	if (process.platform !== "darwin") return body()
	const original = execFileSync("pbpaste", [], { encoding: "utf-8" })
	try {
		await body()
	} finally {
		execFileSync("pbcopy", [], { input: original, encoding: "utf-8" })
	}
}

/** Seed linux with clipboard-helper shims so copies land in a capture file. */
function seedClipboardShims(homeDir: string) {
	if (process.platform !== "linux") return undefined
	const binDir = join(homeDir, "bin")
	mkdirSync(binDir)
	const shim = `#!/bin/sh\ncat > ${JSON.stringify(join(homeDir, "clipboard-capture.txt"))}\n`
	for (const helper of ["wl-copy", "xclip", "xsel"]) {
		const helperPath = join(binDir, helper)
		writeFileSync(helperPath, shim)
		chmodSync(helperPath, 0o755)
	}
	return {
		env: { DISPLAY: "", WAYLAND_DISPLAY: "wayland-test", PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
	}
}

/** Track down the first/last reply token on screen and return 1-based SGR coordinates. */
function findSelectionSpan(
	terminal: Terminal,
	firstToken = TOKENS[0],
	lastToken = TOKENS[TOKENS.length - 1],
): { x1: number; y1: number; x2: number; y2: number } {
	const rows = terminal.getViewableBuffer().map((row) => row.join(""))
	let y1 = -1
	let x1 = -1
	let y2 = -1
	let x2 = -1
	for (let i = 0; i < rows.length; i++) {
		const a = rows[i].indexOf(firstToken)
		if (y1 === -1 && a !== -1) {
			y1 = i
			x1 = a
		}
		const b = rows[i].indexOf(lastToken)
		if (b !== -1) {
			y2 = i
			x2 = b + lastToken.length - 1 // 0-based col of the token's last char
		}
	}
	if (y1 === -1 || y2 === -1 || y2 <= y1) {
		throw new Error(
			`Reply did not render as a wrapped paragraph on screen (first row ${y1}, last row ${y2}).\n\nView:\n${rows.join("\n")}`,
		)
	}
	// SGR mouse coordinates are 1-based.
	return { x1: x1 + 1, y1: y1 + 1, x2: x2 + 1, y2: y2 + 1 }
}

/** Drag a character selection from (x1,y1) to (x2,y2) via SGR mouse events and release. */
function dragSelect(terminal: Terminal, span: { x1: number; y1: number; x2: number; y2: number }): void {
	terminal.write(`\x1b[<0;${span.x1};${span.y1}M`) // press
	const midY = Math.floor((span.y1 + span.y2) / 2)
	terminal.write(`\x1b[<32;${span.x1};${midY}M`)
	terminal.write(`\x1b[<32;${span.x2};${span.y2}M`)
	terminal.write(`\x1b[<0;${span.x2};${span.y2}m`) // release
}

/** Wait until the clipboard contains the reply's first and last tokens (selection proof). */
async function waitForClipboardSpan(
	probe: ClipboardProbe,
	first = TOKENS[0],
	last = TOKENS[TOKENS.length - 1],
	timeoutMs = 5_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs
	let lastSeen = ""
	while (Date.now() < deadline) {
		try {
			lastSeen = probe.read()
			if (lastSeen.includes(first) && lastSeen.includes(last)) return lastSeen
		} catch {
			// not yet
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(
		`Timed out waiting for selection on clipboard. Last seen (${lastSeen.length} chars): ${JSON.stringify(lastSeen.slice(0, 240))}`,
	)
}

notWindows("/copy and Ctrl+X copy the last message without terminal line breaks", async ({ terminal }) => {
	await withClipboardSaved(async () => {
		await runKimchiSession(
			terminal,
			{
				artifactName: "copy-message-regular",
				responses: RESPONSES,
				seedHome: seedClipboardShims,
			},
			async (fixture, trace) => {
				const clipboard = clipboardProbe(fixture.homeDir)

				terminal.submit(PROMPT)
				await waitForText(terminal, TOKENS[TOKENS.length - 1], { timeoutMs: STREAM_TIMEOUT_MS })
				trace.step("long paragraph reply rendered")

				clipboard.writeSentinel("sentinel-before-copy-command")
				terminal.submit("/copy")
				await waitForClipboard(clipboard, REPLY)
				trace.step("/copy placed the raw message on the clipboard")
				expect(clipboard.read()).toBe(REPLY)
				expect(clipboard.read()).not.toContain("\n")

				// Ctrl+X must reach pi's app.message.copy handler when no background
				// agent is running (the agents extension only consumes it as a kill
				// binding while background agents are active).
				clipboard.writeSentinel("sentinel-before-ctrl-x")
				terminal.keyPress("x", { ctrl: true })
				await waitForClipboard(clipboard, REPLY)
				trace.step("Ctrl+X placed the raw message on the clipboard")
				expect(clipboard.read()).toBe(REPLY)
			},
		)
	})
})

notWindows("fullscreen Ctrl+X copies the raw message", async ({ terminal }) => {
	await withClipboardSaved(async () => {
		await runKimchiSession(
			terminal,
			{
				artifactName: "copy-message-fullscreen",
				responses: RESPONSES,
				sessionTuiMode: "fullscreen",
				seedHome: seedClipboardShims,
			},
			async (fixture, trace) => {
				const clipboard = clipboardProbe(fixture.homeDir)

				terminal.submit(PROMPT)
				await waitForText(terminal, TOKENS[TOKENS.length - 1], { timeoutMs: STREAM_TIMEOUT_MS, full: false })
				trace.step("long paragraph reply rendered (fullscreen)")

				clipboard.writeSentinel("sentinel-fullscreen")
				terminal.keyPress("x", { ctrl: true })
				await waitForClipboard(clipboard, REPLY)
				trace.step("fullscreen Ctrl+X placed the raw message on the clipboard")
				expect(clipboard.read()).toBe(REPLY)
			},
		)
	})
})

notWindows("fullscreen partial selection across a soft wrap pastes without hard breaks", async ({ terminal }) => {
	await withClipboardSaved(async () => {
		await runKimchiSession(
			terminal,
			{
				artifactName: "copy-selection-fullscreen",
				responses: RESPONSES,
				sessionTuiMode: "fullscreen",
				seedHome: seedClipboardShims,
			},
			async (fixture, trace) => {
				const clipboard = clipboardProbe(fixture.homeDir)

				terminal.submit(PROMPT)
				await waitForText(terminal, TOKENS[TOKENS.length - 1], { timeoutMs: STREAM_TIMEOUT_MS, full: false })
				trace.step("long paragraph reply rendered (fullscreen)")

				const span = findSelectionSpan(terminal)
				clipboard.writeSentinel("sentinel-selection")
				dragSelect(terminal, span)
				trace.step(`selected from ${span.x1},${span.y1} to ${span.x2},${span.y2}`)

				// copyOnSelect (default on) copies on mouse release.
				const copied = await waitForClipboardSpan(clipboard)
				trace.step(`selection copied (${copied.length} chars)`)

				// The whole wrapped paragraph was selected; reconstruction must
				// restore the exact logical line — no wrap breaks, one glue space
				// per wrap point, no structural padding.
				expect(copied).toBe(REPLY)
			},
		)
	})
})

// Narrow geometry exercises the two wrap paths the 120-column suite never
// reaches: mid-word breaks (glue "") and selections that start on a wrapped
// continuation row rather than the paragraph's first row.
test.describe("narrow geometry selection copy", () => {
	test.use({ shell: Shell.Bash, rows: 40, columns: 48 })

	notWindows("a mid-word wrap rejoins without inserting a space", async ({ terminal }) => {
		// 90-char unbroken token: wider than the usable row at 48 columns, so the
		// wrap must split it mid-token and rejoin with empty glue.
		const longToken = "a".repeat(90)
		const narrowReply = `${longToken} tail-end`
		await withClipboardSaved(async () => {
			await runKimchiSession(
				terminal,
				{
					artifactName: "copy-selection-narrow-midword",
					responses: [{ stream: [narrowReply] }],
					sessionTuiMode: "fullscreen",
					seedHome: seedClipboardShims,
				},
				async (fixture, trace) => {
					const clipboard = clipboardProbe(fixture.homeDir)

					terminal.submit(PROMPT)
					await waitForText(terminal, "tail-end", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
					trace.step("mid-word-wrapped reply rendered")

					const span = findSelectionSpan(terminal, "aaaa", "tail-end")
					clipboard.writeSentinel("sentinel-midword")
					dragSelect(terminal, span)
					trace.step(`selected from ${span.x1},${span.y1} to ${span.x2},${span.y2}`)

					const copied = await waitForClipboardSpan(clipboard, "aaaa", "tail-end")
					trace.step(`selection copied (${copied.length} chars)`)
					expect(copied).toBe(narrowReply)
				},
			)
		})
	})

	notWindows("a selection starting on a wrapped continuation row reconstructs the suffix", async ({ terminal }) => {
		await withClipboardSaved(async () => {
			await runKimchiSession(
				terminal,
				{
					artifactName: "copy-selection-narrow-midstart",
					responses: RESPONSES,
					sessionTuiMode: "fullscreen",
					seedHome: seedClipboardShims,
				},
				async (fixture, trace) => {
					const clipboard = clipboardProbe(fixture.homeDir)
					const startToken = TOKENS[34] // t35 — mid-paragraph, lands on a continuation row at 48 cols
					const expected = TOKENS.slice(34).join(" ")

					terminal.submit(PROMPT)
					await waitForText(terminal, TOKENS[TOKENS.length - 1], { timeoutMs: STREAM_TIMEOUT_MS, full: false })
					trace.step("wrapped reply rendered at narrow width")

					const span = findSelectionSpan(terminal, startToken, TOKENS[TOKENS.length - 1])
					clipboard.writeSentinel("sentinel-midstart")
					dragSelect(terminal, span)
					trace.step(`selected from ${span.x1},${span.y1} to ${span.x2},${span.y2}`)

					const copied = await waitForClipboardSpan(clipboard, startToken, TOKENS[TOKENS.length - 1])
					trace.step(`selection copied (${copied.length} chars)`)
					expect(copied).toBe(expected)
				},
			)
		})
	})
})
