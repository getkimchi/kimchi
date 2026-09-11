/**
 * Tests for the `kimchi memory` CLI subcommand shell: output routing
 * (text vs --json), exit-code propagation, and the non-interactive
 * confirm-decline branch that keeps scripted resets from hanging.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { runAdminCommand } from "../extensions/memory/admin.js"
import { runMemory } from "./memory.js"

vi.mock("../extensions/memory/admin.js", () => ({ runAdminCommand: vi.fn() }))

describe("runMemory (CLI shell)", () => {
	afterEach(() => {
		vi.mocked(runAdminCommand).mockReset()
	})

	it("prints text output and propagates the exit code", async () => {
		vi.mocked(runAdminCommand).mockResolvedValue({ text: "the text", json: "{}", code: 0, useJson: false })
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			expect(await runMemory(["list"])).toBe(0)
			expect(runAdminCommand).toHaveBeenCalledWith(["list"], expect.objectContaining({ cwd: process.cwd() }))
			expect(log).toHaveBeenCalledWith("the text")
		} finally {
			log.mockRestore()
		}
	})

	it("prints the JSON rendering when --json was passed", async () => {
		vi.mocked(runAdminCommand).mockResolvedValue({ text: "t", json: '{\n  "a": 1\n}', code: 0, useJson: true })
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			await runMemory(["list", "--json"])
			expect(log).toHaveBeenCalledWith('{\n  "a": 1\n}')
		} finally {
			log.mockRestore()
		}
	})

	it("propagates a nonzero exit code", async () => {
		vi.mocked(runAdminCommand).mockResolvedValue({ text: "Not found: x", json: "{}", code: 1, useJson: false })
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			expect(await runMemory(["delete", "x"])).toBe(1)
			expect(log).toHaveBeenCalledWith("Not found: x")
		} finally {
			log.mockRestore()
		}
	})

	it("declines interactive resets on non-TTY stdin instead of hanging", async () => {
		// vitest's stdin is not a TTY — the branch scripts depend on.
		vi.mocked(runAdminCommand).mockResolvedValue({ text: "Cancelled.", json: "{}", code: 1, useJson: false })
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			await runMemory(["reset", "--scope", "personal"])
			const confirm = vi.mocked(runAdminCommand).mock.calls[0]?.[1]?.confirm
			expect(confirm).toBeDefined()
			const proceed = await confirm?.("Reset the personal store?")
			expect(proceed).toBe(false)
			expect(log).toHaveBeenCalledWith(expect.stringContaining("pass --yes to proceed"))
		} finally {
			log.mockRestore()
		}
	})
})
