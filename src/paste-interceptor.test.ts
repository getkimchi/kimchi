import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { installPasteInterceptor, looksLikeRawPaste, rewriteCRToLF } from "./paste-interceptor.js"

const ESC = String.fromCharCode(0x1b)

describe("looksLikeRawPaste", () => {
	it("is false for a single character", () => {
		expect(looksLikeRawPaste("a")).toBe(false)
		expect(looksLikeRawPaste("\r")).toBe(false)
	})

	it("is false for two \\r in a short chunk (below length threshold)", () => {
		// Length 3 — a human could plausibly type this; not enough signal to treat as paste.
		expect(looksLikeRawPaste("\r\r\r")).toBe(false)
	})

	it("is false for text with only one \\r", () => {
		expect(looksLikeRawPaste("hello world\r")).toBe(false)
	})

	it("is true for a multi-line paste without markers", () => {
		expect(looksLikeRawPaste("one\rtwo\rthree\rhow many lines?")).toBe(true)
	})

	it("is true for exactly two \\r separators in a 4+ byte chunk", () => {
		expect(looksLikeRawPaste("a\rb\r")).toBe(true)
	})

	it("is false when the chunk contains an ESC byte (conservative guard)", () => {
		// An ESC here usually means a key sequence is mixed in — don't corrupt it.
		expect(looksLikeRawPaste(`one\rtwo\r${ESC}[A`)).toBe(false)
	})
})

describe("rewriteCRToLF", () => {
	it("rewrites bare \\r to \\n", () => {
		expect(rewriteCRToLF("one\rtwo\rthree")).toBe("one\ntwo\nthree")
	})

	it("rewrites \\r\\n to \\n (does not double-emit)", () => {
		expect(rewriteCRToLF("a\r\nb\rc")).toBe("a\nb\nc")
	})

	it("leaves chunks without \\r unchanged", () => {
		expect(rewriteCRToLF("hello")).toBe("hello")
		expect(rewriteCRToLF("a\nb")).toBe("a\nb")
	})
})

describe("installPasteInterceptor", () => {
	function makeFakeStdin(): EventEmitter {
		// A plain EventEmitter is enough — the interceptor only uses .emit and .on isn't touched.
		return new EventEmitter()
	}

	function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
		let t = start
		return {
			now: () => t,
			advance: (ms) => {
				t += ms
			},
		}
	}

	it("rewrites \\r to \\n in raw-paste-burst chunks before listeners see them", () => {
		const stdin = makeFakeStdin()
		installPasteInterceptor(stdin as unknown as NodeJS.ReadStream)
		const received: string[] = []
		stdin.on("data", (chunk) => received.push(chunk.toString()))

		stdin.emit("data", "one\rtwo\rthree")

		expect(received).toEqual(["one\ntwo\nthree"])
	})

	it("rewrites a trailing fragment that arrives within the 100 ms TRAILING_WINDOW_MS", () => {
		const stdin = makeFakeStdin()
		const clock = makeClock()
		installPasteInterceptor(stdin as unknown as NodeJS.ReadStream, clock.now)
		const received: string[] = []
		stdin.on("data", (chunk) => received.push(chunk.toString()))

		// Seeding paste burst.
		stdin.emit("data", "A\rB\rC\rD\r")
		// 1 ms later: the kernel-scheduled tail of the same paste — too small to seed on its own (1 \r), but it must still be rewritten.
		clock.advance(1)
		stdin.emit("data", "\rZ")

		// Without the trailing-window rule, the bare \r in the second chunk would reach the Editor as Enter and submit the buffer mid-paste.
		expect(received).toEqual(["A\nB\nC\nD\n", "\nZ"])
	})

	it("extends the trailing window for each subsequent fragment", () => {
		const stdin = makeFakeStdin()
		const clock = makeClock()
		installPasteInterceptor(stdin as unknown as NodeJS.ReadStream, clock.now)
		const received: string[] = []
		stdin.on("data", (chunk) => received.push(chunk.toString()))

		stdin.emit("data", "A\rB\rC\r")
		clock.advance(3)
		stdin.emit("data", "D\rE")
		// 3 ms after the last fragment — still within the rolling 100 ms window.
		clock.advance(3)
		stdin.emit("data", "\rF")

		expect(received).toEqual(["A\nB\nC\n", "D\nE", "\nF"])
	})

	it("does NOT rewrite a \\r that arrives after the trailing window has lapsed", () => {
		const stdin = makeFakeStdin()
		const clock = makeClock()
		installPasteInterceptor(stdin as unknown as NodeJS.ReadStream, clock.now)
		const received: string[] = []
		stdin.on("data", (chunk) => received.push(chunk.toString()))

		stdin.emit("data", "A\rB\rC\r")
		// 250 ms gap — well past the 100 ms window. A \r arriving now is a typed Enter (perceive-decide-press takes ≥300 ms), not paste.
		clock.advance(250)
		stdin.emit("data", "\r")

		expect(received).toEqual(["A\nB\nC\n", "\r"])
	})

	it("passes through chunks that don't look like a paste and have no active window", () => {
		const stdin = makeFakeStdin()
		installPasteInterceptor(stdin as unknown as NodeJS.ReadStream)
		const received: string[] = []
		stdin.on("data", (chunk) => received.push(chunk.toString()))

		stdin.emit("data", "\r")
		stdin.emit("data", "hello")
		stdin.emit("data", `${ESC}[A`) // arrow key — must not be rewritten

		expect(received).toEqual(["\r", "hello", `${ESC}[A`])
	})

	it("never rewrites chunks that contain ESC, even inside the trailing window", () => {
		const stdin = makeFakeStdin()
		const clock = makeClock()
		installPasteInterceptor(stdin as unknown as NodeJS.ReadStream, clock.now)
		const received: string[] = []
		stdin.on("data", (chunk) => received.push(chunk.toString()))

		stdin.emit("data", "A\rB\rC\r")
		clock.advance(1)
		// An arrow key arriving immediately after a paste — must reach the Editor unmodified or cursor movement breaks.
		stdin.emit("data", `${ESC}[A`)

		expect(received).toEqual(["A\nB\nC\n", `${ESC}[A`])
	})

	it("passes non-data events through unchanged", () => {
		const stdin = makeFakeStdin()
		installPasteInterceptor(stdin as unknown as NodeJS.ReadStream)
		let endCalled = 0
		stdin.on("end", () => endCalled++)

		stdin.emit("end")

		expect(endCalled).toBe(1)
	})

	it("is idempotent — calling install twice does not double-wrap emit", () => {
		const stdin = makeFakeStdin()
		installPasteInterceptor(stdin as unknown as NodeJS.ReadStream)
		const emitAfterFirst = stdin.emit
		installPasteInterceptor(stdin as unknown as NodeJS.ReadStream)
		expect(stdin.emit).toBe(emitAfterFirst)

		// Sanity: a paste chunk still produces exactly one rewritten data event, not two.
		const received: string[] = []
		stdin.on("data", (chunk) => received.push(chunk.toString()))
		stdin.emit("data", "one\rtwo\rthree")
		expect(received).toEqual(["one\ntwo\nthree"])
	})
})
