import { describe, expect, it, vi } from "vitest"
import { ERROR_FG, ORANGE_FG, RST_FG, SUCCESS_FG } from "../../ansi.js"
import { formatRiskBadge, promptForApproval, promptForCompoundApproval, truncate } from "./prompts.js"

describe("truncate helper", () => {
	it("returns original string if under max length", () => {
		expect(truncate("short", 10)).toBe("short")
	})

	it("truncates strings exceeding max length", () => {
		expect(truncate("hello world", 5)).toBe("hell…")
	})

	it("handles exact length strings", () => {
		expect(truncate("hello", 5)).toBe("hello")
	})
})

describe("promptForApproval — withWorkingHidden", () => {
	function fakeCtx() {
		return {
			hasUI: true,
			ui: {
				select: vi.fn(async () => "Yes — just this call"),
				input: vi.fn(),
				setWorkingVisible: vi.fn(),
				theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for test
		} as any
	}

	it("hides working indicator before select and shows it after", async () => {
		const ctx = fakeCtx()
		await promptForApproval({ toolName: "bash", input: { command: "echo hello" }, ctx })

		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(1, false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(2, true)
		// Should be called exactly twice: hide before, show after
		expect(ctx.ui.setWorkingVisible).toHaveBeenCalledTimes(2)
	})

	it("shows working indicator even if select throws", async () => {
		const ctx = fakeCtx()
		ctx.ui.select = vi.fn(async () => {
			throw new Error("select failed")
		})
		await expect(promptForApproval({ toolName: "bash", input: { command: "echo hello" }, ctx })).rejects.toThrow(
			"select failed",
		)

		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(1, false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(2, true)
	})

	it("hides working indicator before feedback input and shows it after", async () => {
		const ctx = fakeCtx()
		ctx.ui.select = vi.fn(async () => "No — tell the assistant what to do differently")
		ctx.ui.input = vi.fn(async () => "Changed my mind")

		const result = await promptForApproval({ toolName: "bash", input: { command: "echo hello" }, ctx })

		expect(result).toEqual({ kind: "deny-with-feedback", feedback: "Changed my mind" })
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(1, false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(2, true)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(3, false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(4, true)
	})
})

describe("promptForCompoundApproval", () => {
	it("stores program wildcards without the RTK wrapper", async () => {
		const ctx = {
			hasUI: true,
			ui: {
				select: vi.fn(async () => "Allow all from now on"),
				setWorkingVisible: vi.fn(),
				theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for test
		} as any

		const result = await promptForCompoundApproval({
			toolName: "bash",
			commands: [{ command: "rtk git status" }, { command: "rtk kubectl get pods" }],
			ctx,
		})

		expect(result).toEqual({
			kind: "allow-all-remember",
			rules: [
				{ toolName: "bash", content: "git *", behavior: "allow", source: "session" },
				{ toolName: "bash", content: "kubectl *", behavior: "allow", source: "session" },
			],
		})
	})
})

describe("formatRiskBadge", () => {
	it("formats low risk with success (green) color", () => {
		const result = formatRiskBadge("low")
		expect(result).toContain("low risk")
		expect(result).toContain(SUCCESS_FG)
		expect(result).toContain(RST_FG)
	})

	it("formats medium risk with orange color", () => {
		const result = formatRiskBadge("medium")
		expect(result).toContain("medium risk")
		expect(result).toContain(ORANGE_FG)
		expect(result).toContain(RST_FG)
	})

	it("formats high risk with error (red) color", () => {
		const result = formatRiskBadge("high")
		expect(result).toContain("high risk")
		expect(result).toContain(ERROR_FG)
		expect(result).toContain(RST_FG)
	})
})

describe("promptForApproval — risk-first layout", () => {
	function fakeCtx() {
		return {
			hasUI: true,
			ui: {
				select: vi.fn(async () => "Yes — just this call"),
				input: vi.fn(),
				setWorkingVisible: vi.fn(),
				theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for test
		} as any
	}

	const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")
	function stripAnsi(s: string): string {
		return s.replace(ansiEscape, "")
	}

	it("shows risk badge + command on first line, explanation indented below", async () => {
		const ctx = fakeCtx()
		await promptForApproval({
			toolName: "bash",
			input: { command: "rm -rf docs" },
			ctx,
			subtitle: "Deleting the entire docs directory recursively...",
			riskScore: "high",
		})

		const callArgs = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0]
		const promptText = callArgs[0] as string
		expect(promptText).toContain("high risk")
		expect(promptText).toContain(ERROR_FG)
		expect(stripAnsi(promptText)).toContain("rm -rf docs")
		expect(promptText).toContain("Deleting the entire docs directory recursively...")
		expect(promptText).toContain("Allow the assistant to run this?")
	})

	it("shows explanation for low risk when subtitle is provided", async () => {
		const ctx = fakeCtx()
		await promptForApproval({
			toolName: "bash",
			input: { command: "ls" },
			ctx,
			subtitle: "harmless listing",
			riskScore: "low",
		})

		const callArgs = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0]
		const promptText = callArgs[0] as string
		expect(promptText).toContain("low risk")
		expect(promptText).toContain(SUCCESS_FG)
		expect(promptText).toContain("harmless listing")
		expect(promptText).toContain("Allow the assistant to run this?")
	})

	it("shows just the command when no risk score (default mode)", async () => {
		const ctx = fakeCtx()
		await promptForApproval({
			toolName: "bash",
			input: { command: "echo hello" },
			ctx,
		})

		const callArgs = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0]
		const promptText = callArgs[0] as string
		expect(stripAnsi(promptText)).toContain("bash(echo hello)")
		expect(promptText).toContain("Allow the assistant to run this?")
		expect(promptText).not.toContain("high risk")
		expect(promptText).not.toContain("medium risk")
		expect(promptText).not.toContain("low risk")
	})

	it("shows subtitle without risk badge when riskScore is undefined", async () => {
		const ctx = fakeCtx()
		await promptForApproval({
			toolName: "bash",
			input: { command: "echo hello" },
			ctx,
			subtitle: "some explanation",
		})

		const callArgs = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0]
		const promptText = callArgs[0] as string
		expect(stripAnsi(promptText)).toContain("bash(echo hello)")
		expect(promptText).toContain("some explanation")
	})
})
