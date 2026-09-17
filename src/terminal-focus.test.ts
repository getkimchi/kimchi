import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ESC = String.fromCharCode(0x1b)
const FOCUS_IN = `${ESC}[I`
const FOCUS_OUT = `${ESC}[O`
const ENABLE = `${ESC}[?1004h`
const DISABLE = `${ESC}[?1004l`

// installFocusTracking keeps module-level singleton state, so each test
// re-imports a fresh module instance.
async function freshFocusModule() {
	vi.resetModules()
	return await import("./terminal-focus.js")
}

function setTTY(tty: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true })
	Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true })
}

function makeFakeStdin(): EventEmitter {
	// A plain EventEmitter is enough — the tracker only uses .emit.
	return new EventEmitter()
}

const capableEnv = { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" }

describe("canDetectFocus", () => {
	beforeEach(() => setTTY(true))
	afterEach(() => setTTY(false))

	it("is true in a supporting terminal", async () => {
		const mod = await freshFocusModule()
		expect(mod.canDetectFocus(capableEnv)).toBe(true)
	})

	it("is false when stdin/stdout are not TTYs", async () => {
		setTTY(false)
		const mod = await freshFocusModule()
		expect(mod.canDetectFocus(capableEnv)).toBe(false)
	})

	it("is false inside tmux (needs set -g focus-events on, can't verify)", async () => {
		const mod = await freshFocusModule()
		expect(mod.canDetectFocus({ ...capableEnv, TMUX: "0" })).toBe(false)
	})

	it("is false on Linux console, dumb terminals, and GNU screen", async () => {
		const mod = await freshFocusModule()
		for (const term of ["linux", "dumb", "screen", "screen.xterm-256color"]) {
			expect(mod.canDetectFocus({ ...capableEnv, TERM: term })).toBe(false)
		}
	})

	it("is false in Apple Terminal.app (never implemented DECSET 1004)", async () => {
		const mod = await freshFocusModule()
		expect(mod.canDetectFocus({ ...capableEnv, TERM_PROGRAM: "Apple_Terminal" })).toBe(false)
	})

	it("is false on Windows conhost but true in Windows Terminal", async () => {
		const mod = await freshFocusModule()
		expect(mod.canDetectFocus({ ...capableEnv, platform: "win32" })).toBe(false)
		expect(mod.canDetectFocus({ ...capableEnv, platform: "win32", WT_SESSION: "abc" })).toBe(true)
	})
})

describe("FocusEventFilter", () => {
	it("tracks focus-out and focus-in", async () => {
		const mod = await freshFocusModule()
		const f = new mod.FocusEventFilter()
		expect(f.isFocused()).toBe(true)
		expect(f.feed(FOCUS_OUT)).toBe("")
		expect(f.isFocused()).toBe(false)
		expect(f.feed(FOCUS_IN)).toBe("")
		expect(f.isFocused()).toBe(true)
	})

	it("strips focus sequences embedded in a chunk and keeps the rest", async () => {
		const mod = await freshFocusModule()
		const f = new mod.FocusEventFilter()
		expect(f.feed(`hello${FOCUS_OUT}world`)).toBe("helloworld")
		expect(f.isFocused()).toBe(false)
	})

	it("last event wins when several focus sequences arrive in one chunk", async () => {
		const mod = await freshFocusModule()
		const f = new mod.FocusEventFilter()
		expect(f.feed(`${FOCUS_IN}${FOCUS_OUT}`)).toBe("")
		expect(f.isFocused()).toBe(false)
	})

	it("passes non-focus CSI sequences through unchanged", async () => {
		const mod = await freshFocusModule()
		const f = new mod.FocusEventFilter()
		// Arrow key, ctrl+right, plain ESC then I typed by the user.
		expect(f.feed(`${ESC}[A`)).toBe(`${ESC}[A`)
		expect(f.feed(`${ESC}[1;5C`)).toBe(`${ESC}[1;5C`)
		expect(f.feed("x")).toBe("x")
		expect(f.feed(`${ESC}I`)).toBe(`${ESC}I`)
		expect(f.isFocused()).toBe(true)
	})

	it("completes a focus sequence split across chunks", async () => {
		const mod = await freshFocusModule()
		const f = new mod.FocusEventFilter()
		expect(f.feed(`${ESC}[`)).toBe("")
		expect(f.feed("O")).toBe("")
		expect(f.isFocused()).toBe(false)
	})

	it("merges a split CSI key sequence byte-preservingly", async () => {
		const mod = await freshFocusModule()
		const f = new mod.FocusEventFilter()
		expect(f.feed(`${ESC}[`)).toBe("")
		expect(f.feed("A")).toBe(`${ESC}[A`)
		expect(f.isFocused()).toBe(true)
	})

	it("holds a lone trailing ESC and merges it with the next chunk", async () => {
		const mod = await freshFocusModule()
		// Split focus event: "\x1b" at end of one chunk, "[O" at the start of the next.
		const f = new mod.FocusEventFilter()
		expect(f.feed(`x${ESC}`)).toBe("x")
		expect(f.feed("[O")).toBe("")
		expect(f.isFocused()).toBe(false)
		// The same lone ESC followed by bytes that DON'T complete a focus
		// sequence passes through byte-preservingly.
		const g = new mod.FocusEventFilter()
		expect(g.feed(`x${ESC}`)).toBe("x")
		expect(g.feed("O")).toBe(`${ESC}O`)
		expect(g.isFocused()).toBe(true)
		// A bare I/O with nothing pending is plain input, not a focus event.
		expect(g.feed("I")).toBe("I")
		expect(g.isFocused()).toBe(true)
	})
})

describe("installFocusTracking", () => {
	beforeEach(() => setTTY(true))
	afterEach(() => setTTY(false))

	it("writes the enable sequence and strips focus events before listeners", async () => {
		const mod = await freshFocusModule()
		const stdin = makeFakeStdin()
		const writes: string[] = []
		expect(mod.installFocusTracking(stdin as unknown as NodeJS.ReadStream, (s) => writes.push(s), capableEnv)).toBe(
			true,
		)
		expect(writes).toEqual([ENABLE])
		expect(mod.isFocusTrackingEnabled()).toBe(true)

		const received: string[] = []
		stdin.on("data", (chunk: Buffer) => received.push(chunk.toString("utf8")))
		stdin.emit("data", Buffer.from(`${FOCUS_OUT}abc`, "utf8"))
		expect(received).toEqual(["abc"])
		expect(mod.hasTerminalFocus()).toBe(false)
		stdin.emit("data", Buffer.from(FOCUS_IN, "utf8"))
		expect(mod.hasTerminalFocus()).toBe(true)
	})

	it("returns false without wrapping stdin when focus can't be detected", async () => {
		const mod = await freshFocusModule()
		const stdin = makeFakeStdin()
		const writes: string[] = []
		expect(
			mod.installFocusTracking(stdin as unknown as NodeJS.ReadStream, (s) => writes.push(s), {
				...capableEnv,
				TMUX: "0",
			}),
		).toBe(false)
		expect(writes).toEqual([])
		expect(mod.isFocusTrackingEnabled()).toBe(false)

		const received: string[] = []
		stdin.on("data", (chunk: Buffer) => received.push(chunk.toString("utf8")))
		stdin.emit("data", Buffer.from(FOCUS_OUT, "utf8"))
		expect(received).toEqual([FOCUS_OUT])
		expect(mod.hasTerminalFocus()).toBe(true)
	})

	it("disableFocusTracking writes the disable sequence only when enabled", async () => {
		const mod = await freshFocusModule()
		const stdin = makeFakeStdin()
		const writes: string[] = []
		mod.installFocusTracking(stdin as unknown as NodeJS.ReadStream, (s) => writes.push(s), capableEnv)
		mod.disableFocusTracking((s) => writes.push(s))
		expect(writes).toEqual([ENABLE, DISABLE])

		// A module where tracking was never enabled writes nothing.
		const mod2 = await freshFocusModule()
		const writes2: string[] = []
		mod2.installFocusTracking(stdin as unknown as NodeJS.ReadStream, (s) => writes2.push(s), {
			...capableEnv,
			TERM_PROGRAM: "Apple_Terminal",
		})
		mod2.disableFocusTracking((s) => writes2.push(s))
		expect(writes2).toEqual([])
	})
})
