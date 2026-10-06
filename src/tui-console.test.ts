import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { ProcessTerminal } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest"
import { installTuiConsoleLogging } from "./tui-console.js"

describe("TUI console logging", () => {
	let directory: string
	let restore: (() => void) | undefined
	let originalConsole = globalThis.console
	let start: MockInstance<ProcessTerminal["start"]>
	let stop: MockInstance<ProcessTerminal["stop"]>

	beforeEach(() => {
		originalConsole = globalThis.console
		directory = mkdtempSync(join(tmpdir(), "kimchi-tui-console-"))
		vi.stubEnv("PI_CODING_AGENT_DIR", directory)
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", directory)
		expect(getAgentDir()).toBe(directory)
		start = vi.spyOn(ProcessTerminal.prototype, "start").mockImplementation(() => {})
		stop = vi.spyOn(ProcessTerminal.prototype, "stop").mockImplementation(() => {})
		restore = installTuiConsoleLogging()
	})

	afterEach(() => {
		restore?.()
		globalThis.console = originalConsole
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		rmSync(directory, { recursive: true, force: true })
	})

	it("keeps ordinary output unchanged until a terminal starts, then saves all console formats privately", () => {
		const stdout = vi.spyOn(console, "log").mockImplementation(() => {})
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
		console.log("plain CLI output")
		expect(stdout).toHaveBeenCalledWith("plain CLI output")
		expect(existsSync(join(directory, "logs"))).toBe(false)
		stdout.mockClear()

		const terminal = new ProcessTerminal()
		terminal.start(vi.fn(), vi.fn())
		console.log("log %s", "message")
		console.info("info message")
		console.warn("warning message")
		console.error(new Error("third-party failure"))
		console.debug("debug message")
		console.table([{ message: "table message" }])
		console.trace("trace message")
		expect(stdout).not.toHaveBeenCalled()
		expect(stderr).not.toHaveBeenCalled()
		const log = readFileSync(join(directory, "logs", "tui.log"), "utf8")
		for (const message of [
			"log message",
			"info message",
			"warning message",
			"third-party failure",
			"debug message",
			"table message",
			"trace message",
		]) {
			expect(log).toContain(message)
		}
		if (process.platform !== "win32") {
			expect(statSync(join(directory, "logs")).mode & 0o777).toBe(0o700)
			expect(statSync(join(directory, "logs", "tui.log")).mode & 0o777).toBe(0o600)
		}
		terminal.stop()
		console.error("visible crash after terminal cleanup")
		expect(stderr).toHaveBeenCalledWith("visible crash after terminal cleanup")
	})

	it("restores output on suspension and captures it again on resume without double installation", () => {
		installTuiConsoleLogging()
		const terminal = new ProcessTerminal()
		terminal.start(vi.fn(), vi.fn())
		terminal.start(vi.fn(), vi.fn())
		console.info("before suspend")
		terminal.stop()
		expect(globalThis.console).toBe(originalConsole)
		terminal.start(vi.fn(), vi.fn())
		console.info("after resume")
		terminal.stop()
		expect(globalThis.console).toBe(originalConsole)
		const log = readFileSync(join(directory, "logs", "tui.log"), "utf8")
		expect(log.match(/before suspend/g)).toHaveLength(1)
		expect(log.match(/after resume/g)).toHaveLength(1)
	})

	it("keeps logging private until the last active terminal stops", () => {
		const first = new ProcessTerminal()
		const second = new ProcessTerminal()
		first.start(vi.fn(), vi.fn())
		second.start(vi.fn(), vi.fn())
		first.stop()
		console.warn("second terminal still owns the screen")
		expect(globalThis.console).not.toBe(originalConsole)
		second.stop()
		expect(globalThis.console).toBe(originalConsole)
		expect(readFileSync(join(directory, "logs", "tui.log"), "utf8")).toContain("second terminal still owns the screen")
	})

	it("restores normal errors when terminal start or stop throws", () => {
		const terminal = new ProcessTerminal()
		start.mockImplementationOnce(() => {
			throw new Error("start failed")
		})
		expect(() => terminal.start(vi.fn(), vi.fn())).toThrow("start failed")
		expect(globalThis.console).toBe(originalConsole)
		terminal.start(vi.fn(), vi.fn())
		stop.mockImplementationOnce(() => {
			throw new Error("stop failed")
		})
		expect(() => terminal.stop()).toThrow("stop failed")
		expect(globalThis.console).toBe(originalConsole)
	})

	it("continues quietly when storage is blocked and saves later logs after it recovers", () => {
		writeFileSync(join(directory, "logs"), "blocked")
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
		const terminal = new ProcessTerminal()
		terminal.start(vi.fn(), vi.fn())
		expect(() => console.error("cannot save this diagnostic")).not.toThrow()
		expect(stderr).not.toHaveBeenCalled()
		rmSync(join(directory, "logs"))
		console.error("storage recovered")
		expect(readFileSync(join(directory, "logs", "tui.log"), "utf8")).toContain("storage recovered")
	})

	it("replaces a full log and bounds an oversized diagnostic", () => {
		const terminal = new ProcessTerminal()
		terminal.start(vi.fn(), vi.fn())
		console.log("old entry")
		const path = join(directory, "logs", "tui.log")
		writeFileSync(path, "x".repeat(1024 * 1024))
		console.log("new entry")
		expect(readFileSync(path, "utf8")).not.toContain("xxxx")
		console.log(`${"x".repeat(2 * 1024 * 1024)} final marker`)
		expect(statSync(path).size).toBeLessThanOrEqual(1024 * 1024)
		expect(readFileSync(path, "utf8")).toContain("final marker")
	})
})
