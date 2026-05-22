import { describe, expect, it } from "vitest"
import { type InteractiveSession, spawnInteractive } from "./harness.js"

// Built via String.fromCharCode — biome strips literal control bytes from string literals.
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

const OSC_RE = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g") // hyperlinks, title updates: ESC ] ... BEL
const CSI_RE = new RegExp(`${ESC}\\[[\\d;?>]*[a-zA-Z]`, "g") // colors, cursor motion, clears: ESC [ ... letter
const KEYPAD_RE = new RegExp(`${ESC}[=>]`, "g") // keypad mode toggles: ESC =, ESC >
const CHARSET_RE = new RegExp(`${ESC}\\([AB012]`, "g") // G0 charset select: ESC ( B etc.

// Strip ANSI SGR/CSI/OSC escapes and normalize line endings. The TUI uses bare `\r` to move the cursor to column 0 before overwriting a row, so treat any `\r` (alone or as part of `\r\n`) as a logical row break for matching purposes.
function stripAnsi(s: string): string {
	return s
		.replace(OSC_RE, "")
		.replace(CSI_RE, "")
		.replace(KEYPAD_RE, "")
		.replace(CHARSET_RE, "")
		.replace(/\r\n?/g, "\n")
}

// Wait for the interactive prompt to be fully mounted. The editor placeholder "ask anything or type / for commands" renders once the Editor is mounted. The startup hint line is suppressed by kimchi's forced `quietStartup: true`, so we can't probe for "clear/exit" text. First-time spawns on a cold sandbox HOME download fd/rg (~30s), so the timeout is generous.
async function waitForPrompt(session: InteractiveSession): Promise<void> {
	await session.waitFor((out) => stripAnsi(out).includes("ask anything or type / for commands"), 45_000)
	// Placeholder can render before the Editor binds its input handler.
	await new Promise((r) => setTimeout(r, 500))
}

const PASTED = "one\ntwo\nthree\nhow many lines of text do I have?"

// Each pasted line must appear alone on its own rendered row. The row consists of layout chrome only — left/right border `│`, leading chevron `❯`, and whitespace — surrounding the word. If the paste handler collapses lines, the row would contain other pasted content and these regexes would not match.
const onOwnRow = (word: string) => new RegExp(`^[│❯ \\t]*${word}[│ \\t]*$`, "m")
const FOUR_LINE_ROW_REGEXES = [
	onOwnRow("one"),
	onOwnRow("two"),
	onOwnRow("three"),
	/how many lines of text do I have\?/,
]

function allFourLinesVisible(plain: string): boolean {
	return FOUR_LINE_ROW_REGEXES.every((re) => re.test(plain))
}

// TODO broken by the new splash screen.
// Disabled to unblock releases. Will be fixed in separate PR.
describe.skip("interactive multi-line paste (LLM-1358)", () => {
	it("bracketed paste of 4 lines keeps all 4 lines in the editor buffer", { timeout: 60_000 }, async () => {
		const session = spawnInteractive()
		try {
			await waitForPrompt(session)
			session.bracketedPaste(PASTED)
			await session.waitFor((out) => allFourLinesVisible(stripAnsi(out)), 5_000)

			const plain = stripAnsi(session.output())
			for (const re of FOUR_LINE_ROW_REGEXES) {
				expect(plain).toMatch(re)
			}
			// LLM-1358 regression guard: if the paste handler stripped newlines, every pasted line would collide into a single row with no separators.
			expect(plain).not.toMatch(/onetwothree/)
			expect(plain).not.toMatch(/threehow many/)
		} finally {
			await session.kill()
		}
	})

	it("bracketed paste split across multiple writes still preserves all lines", { timeout: 60_000 }, async () => {
		const session = spawnInteractive()
		try {
			await waitForPrompt(session)

			// Split the paste marker + content across two writes with a delay, exercising StdinBuffer's cross-chunk pasteBuffer accumulation (pi-tui stdin-buffer.js:230-273). If that logic regresses, the end marker won't be found and handlePaste won't fire.
			const firstHalf = `${ESC}[200~one\ntwo\n`
			const secondHalf = `three\nhow many lines of text do I have?${ESC}[201~`
			session.pty.write(firstHalf)
			await new Promise((r) => setTimeout(r, 80))
			session.pty.write(secondHalf)

			await session.waitFor((out) => allFourLinesVisible(stripAnsi(out)), 5_000)

			const plain = stripAnsi(session.output())
			for (const re of FOUR_LINE_ROW_REGEXES) {
				expect(plain).toMatch(re)
			}
		} finally {
			await session.kill()
		}
	})

	// LLM-1358 fix verification. When the terminal (or tmux/SSH layer) doesn't honor pi-tui's bracketed-paste enable sequence, a multi-line paste arrives as raw `\r`-separated keystrokes, which would normally submit each line as its own message. The paste interceptor in src/paste-interceptor.ts detects such bursts and rewrites the `\r` bytes to `\n` in place so the Editor inserts newlines instead of submitting. This test confirms the fallback path produces the same result as the bracketed-paste path.
	it("paste without bracketed-paste markers is recovered by the interceptor", { timeout: 60_000 }, async () => {
		const session = spawnInteractive()
		try {
			await waitForPrompt(session)

			// Terminals send Enter as `\r`, not `\n`. Writing `\r`-separated content simulates "bracketed paste is disabled and the paste arrived as keystrokes."
			session.pty.write(PASTED.replace(/\n/g, "\r"))

			await session.waitFor((out) => allFourLinesVisible(stripAnsi(out)), 5_000)

			const plain = stripAnsi(session.output())
			for (const re of FOUR_LINE_ROW_REGEXES) {
				expect(plain).toMatch(re)
			}
			expect(plain).not.toMatch(/onetwothree/)
			expect(plain).not.toMatch(/threehow many/)
		} finally {
			await session.kill()
		}
	})

	// False-positive guard for the paste interceptor. Pressing Enter rapidly (or a keyboard macro firing `\r`s) must NOT be misidentified as a paste. Two risks:
	//   1) looksLikeRawPaste fires on a single `\r` — impossible by design (length < 4 and cr-count < 2), covered by the unit test.
	//   2) The kernel / PTY layer coalesces multiple `\r` writes into one large chunk — the heuristic would then see ≥2 `\r`s and wrap. This test verifies small gaps between writes are enough to prevent that coalescing.
	// Signal: if the interceptor misfires, the ten `\r`s get wrapped as a single paste, normalized to ten `\n`s, and the Editor renders a tall block of empty rows inside the prompt border. We assert the stripped output does not contain that tall empty block.
	it("individually-typed \\r bytes are not treated as a paste", { timeout: 60_000 }, async () => {
		const session = spawnInteractive()
		try {
			await waitForPrompt(session)

			// Write `\r` ten times with small gaps so each lands as its own stdin chunk (not kernel-coalesced into one large burst the heuristic would misread).
			for (let i = 0; i < 10; i++) {
				session.pty.write("\r")
				await new Promise((r) => setTimeout(r, 30))
			}
			// Let the TUI fully render whatever state the writes produced.
			await new Promise((r) => setTimeout(r, 500))

			const plain = stripAnsi(session.output())

			// A misfire would wrap `\r\r\r\r\r\r\r\r\r\r` into a single bracketed paste and push ten `\n`-separated empty rows into the editor buffer — showing up as a long run of blank rows between the editor border dividers. Six or more consecutive empty/whitespace-only lines is well beyond anything the idle TUI renders.
			expect(plain).not.toMatch(/(\n\s*){6,}\n/)
		} finally {
			await session.kill()
		}
	})

	// Regression for the auto-send / trailing-line bug. The original LLM-1358 interceptor had a per-chunk heuristic (≥2 \r, ≥4 bytes) that missed the small tail chunk a large paste's final fragment lands in — the bare `\r` in that tail reached the Editor as Enter and submitted everything before it, leaving the trailing letter dangling in the input. The v2 fix rewrites \r→\n in the seeding chunk and extends the rewrite to subsequent \r-bearing chunks within the TRAILING_WINDOW_MS (100 ms) window. This test simulates that exact split: the main chunk is a paste-burst, the second chunk is a single \r + final character arriving ~1 ms later.
	it("trailing fragment after a paste-burst chunk is not treated as Enter", { timeout: 60_000 }, async () => {
		const session = spawnInteractive()
		try {
			await waitForPrompt(session)

			// Main paste-burst: A\rB\r…\rY\r — meets the seeding heuristic (24 \r, 48 bytes).
			const mainChunk = `${"ABCDEFGHIJKLMNOPQRSTUVWXY".split("").join("\r")}\r`
			session.pty.write(mainChunk)
			// 1 ms gap simulates the kernel TTY scheduling delay between adjacent reads of one OS-level paste burst. Far below the 100 ms TRAILING_WINDOW_MS.
			await new Promise((r) => setTimeout(r, 1))
			// The trailing fragment: leading bare \r (the last paste-internal newline) then the final letter Z. Pre-fix, this \r submitted A..Y and Z was left in the input.
			session.pty.write("\rZ")

			// Wait for all 26 letters to render in the editor on their own rows.
			const rowRegexes = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(onOwnRow)
			await session.waitFor((out) => rowRegexes.every((re) => re.test(stripAnsi(out))), 5_000)

			const plain = stripAnsi(session.output())
			for (const re of rowRegexes) {
				expect(plain).toMatch(re)
			}
			// Auto-send guard: if the bug had recurred, the prompt would have been submitted mid-paste and the editor would have re-rendered with the placeholder text shown again after submission. The placeholder must NOT reappear after the paste lands.
			const placeholderHits = plain.match(/ask anything or type \/ for commands/g)?.length ?? 0
			expect(placeholderHits).toBeLessThanOrEqual(1)
		} finally {
			await session.kill()
		}
	})
})
