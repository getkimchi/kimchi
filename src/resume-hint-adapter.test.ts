import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences } from "@earendil-works/pi-tui"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { formatResumeHint, installResumeHintAdapter } from "./resume-hint-adapter.js"

const id = "019b23ba-3480-7889-8c1f-a0c0c0c0c0c0"
const native = `\x1b[2mTo resume this session:\x1b[22m kimchi --session ${id}\n`

beforeAll(() => initTheme("dark", false))
afterEach(() => vi.restoreAllMocks())

describe("resume hint", () => {
	it("uses the resume alias and preserves a quoted custom session directory", () => {
		const hint = `To resume this session: kimchi --session-dir '/tmp/session files' --session ${id}\n`
		expect(stripTerminalSequences(formatResumeHint(hint, id))).toBe(
			`\nSession saved. Pick up where you left off:\n  kimchi --session-dir '/tmp/session files' --resume ${id}\n\n`,
		)
	})

	it.each(["dark", "light"])("colors the UUID with the active %s theme accent", (name) => {
		initTheme(name, false)
		const coloredId = getSelectListTheme().selectedText(id)
		expect(coloredId).not.toBe(id)
		expect(formatResumeHint(native, id)).toContain(`--resume ${coloredId}\n`)
	})

	it("leaves unrelated output and other sessions untouched", () => {
		for (const output of ["some output\n", native.replace(id, "another-id"), `quoted: ${native}`]) {
			expect(formatResumeHint(output, id)).toBe(output)
		}
	})

	it("scopes rewriting to shutdown and preserves write arguments and return values", async () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(false)
		const callback = vi.fn()
		const bytes = Buffer.from("unchanged")
		const mode = {
			isShuttingDown: false,
			sessionManager: { getSessionId: () => id },
			async shutdown() {
				expect(process.stdout.write(bytes)).toBe(false)
				expect(process.stdout.write(native, "utf8", callback)).toBe(false)
			},
		}
		installResumeHintAdapter(mode)
		const wrapped = mode.shutdown
		installResumeHintAdapter(mode)
		expect(mode.shutdown).toBe(wrapped)
		await mode.shutdown()
		expect(write).toHaveBeenCalledWith(bytes)
		expect(write).toHaveBeenCalledWith(formatResumeHint(native, id), "utf8", callback)
		expect(process.stdout.write).toBe(write)
	})

	it("restores stdout if shutdown fails", async () => {
		const write = process.stdout.write
		const mode = {
			isShuttingDown: false,
			sessionManager: { getSessionId: () => id },
			async shutdown() {
				throw new Error("shutdown failed")
			},
		}
		installResumeHintAdapter(mode)
		await expect(mode.shutdown()).rejects.toThrow("shutdown failed")
		expect(process.stdout.write).toBe(write)
	})

	it("leaves signal shutdown untouched", async () => {
		const write = process.stdout.write
		const shutdown = vi.fn(async (_options?: { fromSignal?: boolean }) => {
			expect(process.stdout.write).toBe(write)
		})
		const mode = { isShuttingDown: false, sessionManager: { getSessionId: () => id }, shutdown }
		installResumeHintAdapter(mode)
		await mode.shutdown({ fromSignal: true })
		expect(shutdown).toHaveBeenCalledWith({ fromSignal: true })
	})

	it("leaves repeated shutdown calls to Pi without reading disposed session state", async () => {
		const write = process.stdout.write
		const shutdown = vi.fn(async () => {})
		const mode = {
			isShuttingDown: true,
			get sessionManager(): { getSessionId(): string } {
				throw new Error("session disposed")
			},
			shutdown,
		}
		installResumeHintAdapter(mode)
		await mode.shutdown()
		expect(shutdown).toHaveBeenCalledOnce()
		expect(process.stdout.write).toBe(write)
	})
})
