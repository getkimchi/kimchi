import { describe, expect, it, vi } from "vitest"
import { ERROR_FG, ORANGE_FG, RST_FG, SUCCESS_FG } from "../../ansi.js"
import {
	buildPermissionChoices,
	formatRiskBadge,
	promptForApproval,
	promptForCompoundApproval,
	truncate,
} from "./prompts.js"

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

describe("promptForCompoundApproval", () => {
	function fakeCtx(selectValue: string) {
		return {
			hasUI: true,
			ui: {
				select: vi.fn(async () => selectValue),
				input: vi.fn(async () => "be more careful"),
				notify: vi.fn(),
				setWorkingVisible: vi.fn(),
				theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for test
		} as any
	}

	const commands = [{ command: "git status" }, { command: "ls -la" }]

	it("returns deny when ctx.hasUI is false", async () => {
		const ctx = { hasUI: false } as any
		const result = await promptForCompoundApproval({ toolName: "bash", commands, ctx })
		expect(result).toEqual({ kind: "deny" })
	})

	it("returns allow-all-once when user selects Run all (once)", async () => {
		const ctx = fakeCtx("Run all (once)")
		const result = await promptForCompoundApproval({ toolName: "bash", commands, ctx })
		expect(result).toEqual({ kind: "allow-all-once" })
	})

	it("returns allow-all-remember with narrow per-segment rules when user selects Allow all from now on", async () => {
		const ctx = fakeCtx("Allow all from now on")
		const result = await promptForCompoundApproval({ toolName: "bash", commands, ctx })
		// Narrow scopes, NOT wildcardContent: remembering must not grant more
		// than the subcommands shown on the card (no silent `git *`).
		expect(result).toEqual({
			kind: "allow-all-remember",
			rules: [
				{ toolName: "bash", content: "git status:*", behavior: "allow", source: "session" },
				{ toolName: "bash", content: "ls:*", behavior: "allow", source: "session" },
			],
		})
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("notifies and stores only scopeable rules when a segment cannot be remembered", async () => {
		const ctx = fakeCtx("Allow all from now on")
		const pipeline = "cat server.log | sh"
		const result = await promptForCompoundApproval({
			toolName: "bash",
			commands: [{ command: "cd /tmp" }, { command: pipeline }],
			ctx,
		})
		// Pipe to a non-filter program: the derived scope can never match again
		// (matchBashRule's single-segment canonical gate), so it is dropped…
		expect(result).toEqual({
			kind: "allow-all-remember",
			rules: [{ toolName: "bash", content: "cd /tmp:*", behavior: "allow", source: "session" }],
		})
		// …and the user is told remembering did not cover the whole compound.
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify.mock.calls[0][0]).toContain(pipeline)
	})

	it("stores every head scope and does not warn when piped stages are whitelisted output filters", async () => {
		// `2>&1 | tail -40` is the classic LLM output-bound wrapper: tail is a
		// pure read-only filter, so ALL segments are scopeable — remember stores
		// the head's narrow scope and never warns.
		const ctx = fakeCtx("Allow all from now on")
		const result = await promptForCompoundApproval({
			toolName: "bash",
			commands: [{ command: "cd /tmp" }, { command: "npm install 2>&1 | tail -40" }],
			ctx,
		})

		expect(result).toEqual({
			kind: "allow-all-remember",
			rules: [
				{ toolName: "bash", content: "cd /tmp:*", behavior: "allow", source: "session" },
				{ toolName: "bash", content: "npm install:*", behavior: "allow", source: "session" },
			],
		})
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("returns deny-with-feedback when user selects deny and provides feedback", async () => {
		const ctx = fakeCtx("No — tell the assistant what to do differently")
		const result = await promptForCompoundApproval({ toolName: "bash", commands, ctx })
		expect(result).toEqual({ kind: "deny-with-feedback", feedback: "be more careful" })
	})

	it("returns deny when user selects deny but provides no feedback", async () => {
		const ctx = fakeCtx("No — tell the assistant what to do differently")
		ctx.ui.input = vi.fn(async () => "")
		const result = await promptForCompoundApproval({ toolName: "bash", commands, ctx })
		expect(result).toEqual({ kind: "deny" })
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

describe("buildPermissionChoices — compound bash", () => {
	// The compound gate re-evaluates each segment individually; remembering a
	// compound only sticks when every segment carries a matching rule.
	it("remembers per-segment narrow rules with disclosed scopes", () => {
		const choices = buildPermissionChoices("bash", { command: "cd /tmp && npm install" })
		expect(choices.map((c) => c.kind)).toEqual(["allow-once", "allow-remember", "allow-remember-wildcard", "deny"])

		const remember = choices.find((c) => c.kind === "allow-remember")
		if (remember?.kind !== "allow-remember") throw new Error("missing remember choice")
		expect(remember.rules.map((r) => r.content)).toEqual(["cd /tmp:*", "npm install:*"])
		expect(remember.label).toContain("bash(cd /tmp:*)")
		expect(remember.label).toContain("bash(npm install:*)")
	})

	it("offers a per-segment wildcard variant as an explicit broader choice", () => {
		const choices = buildPermissionChoices("bash", { command: "cd /tmp && npm install" })
		const wildcard = choices.find((c) => c.kind === "allow-remember-wildcard")
		if (wildcard?.kind !== "allow-remember-wildcard") throw new Error("missing wildcard choice")
		expect(wildcard.rules.map((r) => r.content)).toEqual(["cd *", "npm *"])
		expect(wildcard.label).toContain("cd * + npm *")
	})

	it("omits remember choices when any segment is unscopeable", () => {
		const choices = buildPermissionChoices("bash", { command: "cd /tmp && cat server.log | sh" })
		expect(choices.map((c) => c.kind)).toEqual(["allow-once", "deny"])
	})

	it("omits remember choices for a standalone pipe to a non-filter program", () => {
		// `cat x | sh`: any derived scope can never match the piped command
		// (matchBashRule's single-segment canonical gate), so offering
		// "don't ask again" would silently no-op. Same contract as compounds.
		const choices = buildPermissionChoices("bash", { command: "cat server.log | sh" })
		expect(choices.map((c) => c.kind)).toEqual(["allow-once", "deny"])
	})

	it("keeps remember choices for a standalone whitelisted output-filter pipe", () => {
		// head + read-only filter stages normalize to the head, so the scope
		// DOES match reruns (`b0dbd1a4`) — remember is honest here.
		const choices = buildPermissionChoices("bash", { command: "cat server.log | tail -20" })
		expect(choices.map((c) => c.kind)).toEqual(["allow-once", "allow-remember", "allow-remember-wildcard", "deny"])
		const remember = choices.find((c) => c.kind === "allow-remember")
		if (remember?.kind !== "allow-remember") throw new Error("missing remember choice")
		expect(remember.rules.map((r) => r.content)).toEqual(["cat server.log:*"])
	})

	it("offers remember choices when piped stages are whitelisted output filters", () => {
		const choices = buildPermissionChoices("bash", { command: "cd /tmp && npm install 2>&1 | tail -40" })

		expect(choices.map((c) => c.kind)).toEqual(["allow-once", "allow-remember", "allow-remember-wildcard", "deny"])
		const remember = choices.find((c) => c.kind === "allow-remember")
		if (remember?.kind !== "allow-remember") throw new Error("missing remember choice")
		expect(remember.rules.map((r) => r.content)).toEqual(["cd /tmp:*", "npm install:*"])
		expect(remember.label).toContain("bash(cd /tmp:*) + bash(npm install:*)")
		const wildcard = choices.find((c) => c.kind === "allow-remember-wildcard")
		if (wildcard?.kind !== "allow-remember-wildcard") throw new Error("missing wildcard choice")
		expect(wildcard.rules.map((r) => r.content)).toEqual(["cd *", "npm *"])
	})

	it("truncates scope disclosure on long compounds", () => {
		const choices = buildPermissionChoices("bash", { command: "cd a && npm i && git s && ls && pwd" })
		const remember = choices.find((c) => c.kind === "allow-remember")
		if (remember?.kind !== "allow-remember") throw new Error("missing remember choice")
		expect(remember.rules).toHaveLength(5)
		expect(remember.label).toContain("+ 2 more")
	})
})
