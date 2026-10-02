import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	CACHEABLE_OPTION_NAMES,
	CLI_OPTIONS,
	getCliModeArg,
	getParsedCliArgs,
	hasFermentOneshotArg,
	isCliAtFileArg,
	isExperimentalFeaturesArg,
	isHelpOrVersionArgs,
	isPreDispatchValueFlag,
	isProtocolOrPrintMode,
	isTerminalUiMode,
	normalizeResumeIdArgs,
	populateCliArgs,
	stripExperimentalFeaturesArg,
	stripMultiModelArgs,
	takeWorkspaceArgs,
} from "./cli-args.js"
import { normalizeAtFileArgs } from "./fs-paths.js"

describe("workspace launch arguments", () => {
	it.each(["--worktree", "-w"])("removes %s and preserves the child prompt/options", (flag) => {
		expect(takeWorkspaceArgs([flag, "fix/login", "--model", "fake/test", "fix it"], "/repo")).toEqual({
			kind: "worktree",
			name: "fix/login",
			args: ["--model", "fake/test", "fix it"],
		})
	})
	it("supports equals and an explicit branch-only launch", () => {
		expect(takeWorkspaceArgs(["--branch=fix/login", "-p", "hello"], "/repo")).toEqual({
			kind: "branch",
			name: "fix/login",
			args: ["-p", "hello"],
		})
	})
	it("does not interpret flag-shaped values or text after -- as launch flags", () => {
		expect(takeWorkspaceArgs(["--system-prompt", "--worktree", "hello"], "/repo")).toBeUndefined()
		expect(takeWorkspaceArgs(["--", "--worktree", "hello"], "/repo")).toBeUndefined()
	})
	it.each([
		"-nt",
		"-ne",
		"-nbt",
		"-ns",
		"-np",
		"-nc",
		"-na",
	])("preserves Pi's literal %s alias without hiding the worktree flag", (alias) => {
		expect(takeWorkspaceArgs([alias, "--worktree", "fix/login"], "/repo")).toEqual({
			kind: "worktree",
			name: "fix/login",
			args: [alias],
		})
	})
	it("rejects a combined short flag rather than dropping print mode", () => {
		expect(() => takeWorkspaceArgs(["-pw", "fix/login", "hello"], "/repo")).toThrow(/separate/i)
	})
	it("does not treat a session name as a worktree flag", () => {
		expect(takeWorkspaceArgs(["--name", "--worktree", "hello"], "/repo")).toBeUndefined()
	})
	it("preserves an attached resume path without interpreting its letters as flags", () => {
		expect(takeWorkspaceArgs(["-r./work/session.jsonl"], "/repo")).toBeUndefined()
		expect(() => takeWorkspaceArgs(["-r./work/session.jsonl", "-w", "fix/login"], "/repo")).toThrow(/cannot combine/i)
		expect(takeWorkspaceArgs(["-w", "fix/login", "--extension", "-rwork.ts"], "/repo")?.args).toEqual([
			"--extension",
			"/repo/-rwork.ts",
		])
	})
	it("preserves a Pi alias used as a resource filename", () => {
		expect(takeWorkspaceArgs(["-w", "fix/login", "--extension", "-ne"], "/repo")?.args).toEqual([
			"--extension",
			"/repo/-ne",
		])
	})
	it.each([
		["--worktree"],
		["--worktree="],
		["--worktree", "one", "--branch", "two"],
		["-w", "one", "-w", "two"],
	])("rejects missing or conflicting selection: %j", (...args) => {
		expect(() => takeWorkspaceArgs(args, "/repo")).toThrow()
	})
	it.each(["--session", "--resume", "-r", "--fork", "--session-dir"])("rejects %s before any Git mutation", (flag) => {
		expect(() => takeWorkspaceArgs(["-w", "fix/login", flag, "old-session"], "/repo")).toThrow(/cannot combine/i)
	})
	it("allows continuing only the destination's latest session", () => {
		expect(takeWorkspaceArgs(["-w", "fix/login", "-c"], "/repo")?.args).toEqual(["-c"])
	})
	it.each(["--help", "--version", "--list-models", "--export"])("does not create a worktree for %s", (flag) => {
		expect(takeWorkspaceArgs(["-w", "fix/login", flag], "/repo")).toBeUndefined()
	})
	it.each(["acp", "rpc"])("rejects %s clients that choose their own session cwd", (mode) => {
		expect(() => takeWorkspaceArgs(["-w", "fix/login", "--mode", mode], "/repo")).toThrow(/terminal|print/i)
	})
	it("preserves caller-relative attachment and explicit resource paths", () => {
		expect(
			takeWorkspaceArgs(["-w", "fix/login", "@notes.md", "-e", "./tools.ts", "--mcp-config=./mcp.json"], "/repo")?.args,
		).toEqual(["@/repo/notes.md", "-e", "/repo/tools.ts", "--mcp-config=/repo/mcp.json"])
	})
})

describe("value-flag parsing", () => {
	it("treats -na as no-approve while preserving alias-shaped prompt values", () => {
		populateCliArgs(["-na", "--system-prompt", "-ne", "--", "-nt"])
		expect(getParsedCliArgs().options["no-approve"]).toBe(true)
		expect(getParsedCliArgs().options.approve).toBeUndefined()
		expect(getParsedCliArgs().positionals).toEqual(["-nt"])
		populateCliArgs([])
	})
	// Short aliases must consume their value too, or the token after them is
	// parsed as a model selection and silently suppresses the Auto default.
	it.each([
		["-t", "--model"],
		["-e", "--model"],
	])("leaves the model unset when %s consumes a flag-shaped value", (...args) => {
		populateCliArgs(args)
		expect(getParsedCliArgs().options.model).toBeUndefined()
		populateCliArgs([])
	})

	it("caches only an explicitly supplied model scope", () => {
		populateCliArgs(["--models", "kimchi-dev/auto,kimchi-dev/glm-5.3"])
		expect(getParsedCliArgs().options.models).toBe("kimchi-dev/auto,kimchi-dev/glm-5.3")
		populateCliArgs([])
		expect(getParsedCliArgs().options.models).toBeUndefined()
	})
})

describe("getCliModeArg", () => {
	it("reads --mode value", () => {
		expect(getCliModeArg(["--model", "cast/gpt-5", "--mode", "json"])).toBe("json")
	})

	it("reads --mode=value", () => {
		expect(getCliModeArg(["--mode=rpc"])).toBe("rpc")
	})

	it("reads ACP mode for early CLI routing", () => {
		expect(getCliModeArg(["--mode", "acp"])).toBe("acp")
	})

	it("returns undefined when mode is absent or missing a value", () => {
		expect(getCliModeArg([])).toBeUndefined()
		expect(getCliModeArg(["--mode"])).toBeUndefined()
	})
})

describe("isHelpOrVersionArgs", () => {
	it.each([["--help"], ["-h"], ["--version"], ["-v"]])("detects %s", (arg) => {
		expect(isHelpOrVersionArgs([arg])).toBe(true)
	})

	it("returns false without help or version flags", () => {
		expect(isHelpOrVersionArgs(["--mode", "json"])).toBe(false)
	})
})

describe("isProtocolOrPrintMode", () => {
	it.each([
		["pi rpc mode", ["--mode", "rpc"]],
		["pi json mode", ["--mode", "json"]],
		["pi print mode", ["--print", "hello"]],
		["pi short print mode", ["-p", "hello"]],
		["raw equals mode fallback", ["--mode=rpc"]],
		["kimchi acp mode", ["--mode", "acp"]],
	])("returns true for %s", (_name, args) => {
		expect(isProtocolOrPrintMode(args)).toBe(true)
	})

	it("returns false for interactive invocations", () => {
		expect(isProtocolOrPrintMode([])).toBe(false)
		expect(isProtocolOrPrintMode(["fix tests"])).toBe(false)
	})
})

describe("isTerminalUiMode", () => {
	const tty = { stdinIsTTY: true, stdoutIsTTY: true }

	it("returns true for an interactive terminal invocation", () => {
		expect(isTerminalUiMode([], tty)).toBe(true)
	})

	it.each([
		["--mode", "acp"],
		["--mode", "rpc"],
		["--mode=json"],
		["--print"],
		["-p"],
	])("returns false for protocol or print args %j", (...args) => {
		expect(isTerminalUiMode(args, tty)).toBe(false)
	})

	it("returns false when stdin or stdout is not a TTY", () => {
		expect(isTerminalUiMode([], { stdinIsTTY: false, stdoutIsTTY: true })).toBe(false)
		expect(isTerminalUiMode([], { stdinIsTTY: true, stdoutIsTTY: false })).toBe(false)
	})
})

describe("isPreDispatchValueFlag", () => {
	it.each([
		["--provider"],
		["--model"],
		["--api-key"],
		["--system-prompt"],
		["--append-system-prompt"],
		["--session"],
		["--fork"],
		["--session-dir"],
		["--models"],
		["--tools"],
		["-t"],
		["--thinking"],
		["--export"],
		["--extension"],
		["-e"],
		["--skill"],
		["--prompt-template"],
		["--theme"],
	])("detects %s as consuming a value during pre-dispatch scans", (arg) => {
		expect(isPreDispatchValueFlag(arg)).toBe(true)
	})

	it.each([
		["--continue"],
		["--resume"],
		["--no-tools"],
		["--no-themes"],
		["fix tests"],
	])("does not treat %s as a value flag", (arg) => {
		expect(isPreDispatchValueFlag(arg)).toBe(false)
	})
})

describe("normalizeResumeIdArgs", () => {
	it.each([
		[
			["-r", "019f1780-8034-7435-85aa-3e86037676ee"],
			["--session", "019f1780-8034-7435-85aa-3e86037676ee"],
		],
		[
			["--resume", "019f1780-8034-7435-85aa-3e86037676ee"],
			["--session", "019f1780-8034-7435-85aa-3e86037676ee"],
		],
		[
			["--provider", "fake", "-r", "./session.jsonl"],
			["--provider", "fake", "--session", "./session.jsonl"],
		],
		[["--resume=abc123"], ["--session", "abc123"]],
		[["-rabc123"], ["--session", "abc123"]],
	])("rewrites %j to %j", (input, expected) => {
		expect(normalizeResumeIdArgs(input)).toEqual(expected)
	})

	it.each([
		[["-r"]],
		[["--resume"]],
		[["-r", "--model", "fake"]],
		[["-r", "continue the review"]],
	])("leaves bare resume picker args unchanged", (input) => {
		expect(normalizeResumeIdArgs(input)).toEqual(input)
	})
})

describe("isCliAtFileArg", () => {
	it("does not treat known option values as @file attachments", () => {
		expect(isCliAtFileArg("@literal", 1, ["--system-prompt", "@literal"])).toBe(false)
		expect(isCliAtFileArg("@scope/pkg", 1, ["--extension", "@scope/pkg"])).toBe(false)
		expect(isCliAtFileArg("@release", 1, ["--name", "@release"])).toBe(false)
	})

	it("uses parser position instead of matching @ values by text", () => {
		const args = ["--name", "@same", "@same"]

		expect(isCliAtFileArg("@same", 1, args)).toBe(false)
		expect(isCliAtFileArg("@same", 2, args)).toBe(true)
	})

	it("still treats standalone @file args as attachments", () => {
		expect(isCliAtFileArg("@prompt.md", 0, ["@prompt.md"])).toBe(true)
		expect(isCliAtFileArg("@prompt.md", 1, ["--print", "@prompt.md"])).toBe(true)
	})
})

describe("normalizeAtFileArgs with CLI parsing", () => {
	it("leaves @-prefixed option values unchanged", () => {
		const tmp = mkdtempSync(join(tmpdir(), "cli-at-file-args-"))
		try {
			mkdirSync(join(tmp, "literal"))
			mkdirSync(join(tmp, "scope", "pkg"), { recursive: true })
			writeFileSync(join(tmp, "prompt.md"), "hi")

			const result = normalizeAtFileArgs(
				["--system-prompt", "@literal", "--extension", "@scope/pkg", "@prompt.md"],
				tmp,
				isCliAtFileArg,
			)

			expect(result.args).toEqual([
				"--system-prompt",
				"@literal",
				"--extension",
				"@scope/pkg",
				`@${join(tmp, "prompt.md")}`,
			])
			expect(result.directoryArgs).toEqual([])
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	})
})

describe("isExperimentalFeaturesArg", () => {
	it("returns true when flag is present", () => {
		expect(isExperimentalFeaturesArg(["--enable-experimental-features"])).toBe(true)
	})

	it("returns true when mixed with other args", () => {
		expect(isExperimentalFeaturesArg(["--model", "foo", "--enable-experimental-features"])).toBe(true)
	})

	it("returns false when flag is absent", () => {
		expect(isExperimentalFeaturesArg(["--model", "foo"])).toBe(false)
	})

	it("returns false for empty args", () => {
		expect(isExperimentalFeaturesArg([])).toBe(false)
	})
})

describe("hasFermentOneshotArg (Chunk 7 gate composition)", () => {
	it("returns true for the bare flag", () => {
		expect(hasFermentOneshotArg(["--ferment-oneshot"])).toBe(true)
	})

	it("returns true for the kwarg form", () => {
		expect(hasFermentOneshotArg(["ferment-oneshot=true"])).toBe(true)
		expect(hasFermentOneshotArg(["--print", "ferment-oneshot=true"])).toBe(true)
	})

	it("returns true when mixed with other args", () => {
		expect(hasFermentOneshotArg(["--model", "foo", "--print", "--ferment-oneshot"])).toBe(true)
	})

	it("returns false when absent", () => {
		expect(hasFermentOneshotArg(["--print"])).toBe(false)
		expect(hasFermentOneshotArg([])).toBe(false)
	})

	it("returns false when the suffix appears inside an unrelated flag", () => {
		expect(hasFermentOneshotArg(["--foo-ferment-oneshot=true"])).toBe(false)
	})
})

describe("stripExperimentalFeaturesArg", () => {
	it("removes the flag from the array", () => {
		expect(stripExperimentalFeaturesArg(["--enable-experimental-features", "--model", "foo"])).toEqual([
			"--model",
			"foo",
		])
	})

	it("removes all occurrences", () => {
		expect(stripExperimentalFeaturesArg(["--enable-experimental-features", "--enable-experimental-features"])).toEqual(
			[],
		)
	})

	it("returns the array unchanged when flag is absent", () => {
		expect(stripExperimentalFeaturesArg(["--model", "foo"])).toEqual(["--model", "foo"])
	})

	it("returns empty array for empty input", () => {
		expect(stripExperimentalFeaturesArg([])).toEqual([])
	})
})

describe("stripMultiModelArgs", () => {
	it("strips --multi-model", () => {
		expect(stripMultiModelArgs(["--multi-model"])).toEqual([])
	})

	it("strips --model multi-model", () => {
		expect(stripMultiModelArgs(["--model", "multi-model"])).toEqual([])
	})

	it("strips --model=multi-model", () => {
		expect(stripMultiModelArgs(["--model=multi-model"])).toEqual([])
	})

	it("preserves real --model values", () => {
		expect(stripMultiModelArgs(["--model", "kimchi-dev/kimi-k2.7"])).toEqual(["--model", "kimchi-dev/kimi-k2.7"])
		expect(stripMultiModelArgs(["--model=kimchi-dev/kimi-k2.7"])).toEqual(["--model=kimchi-dev/kimi-k2.7"])
	})

	it("preserves surrounding args", () => {
		expect(stripMultiModelArgs(["--provider", "kimchi-dev", "--model", "multi-model", "fix tests"])).toEqual([
			"--provider",
			"kimchi-dev",
			"fix tests",
		])
	})

	it("returns the array unchanged when no multi-model flags are present", () => {
		expect(stripMultiModelArgs(["--provider", "kimchi-dev", "--model", "kimi-k2.7", "fix tests"])).toEqual([
			"--provider",
			"kimchi-dev",
			"--model",
			"kimi-k2.7",
			"fix tests",
		])
	})

	it("strips --multi-model when combined with a real --model value", () => {
		expect(stripMultiModelArgs(["--model", "real-model", "--multi-model"])).toEqual(["--model", "real-model"])
		expect(stripMultiModelArgs(["--multi-model", "--model", "real-model"])).toEqual(["--model", "real-model"])
	})
})

describe("populateCliArgs / getParsedCliArgs", () => {
	it("parses --model multi-model", () => {
		populateCliArgs(["--provider", "kimchi-dev", "--model", "multi-model", "fix tests"])
		expect(getParsedCliArgs()).toEqual({
			options: { provider: "kimchi-dev", model: "multi-model" },
			positionals: ["fix tests"],
		})
	})

	it("parses --multi-model", () => {
		populateCliArgs(["--multi-model", "fix tests"])
		expect(getParsedCliArgs()).toEqual({
			options: { "multi-model": true },
			positionals: ["fix tests"],
		})
	})

	it("parses real --model values", () => {
		populateCliArgs(["--model", "kimchi-dev/kimi-k2.7", "fix tests"])
		expect(getParsedCliArgs()).toEqual({ options: { model: "kimchi-dev/kimi-k2.7" }, positionals: ["fix tests"] })
	})

	it("reports no model option when --model is absent", () => {
		populateCliArgs(["--provider", "kimchi-dev", "fix tests"])
		expect(getParsedCliArgs()).toEqual({ options: { provider: "kimchi-dev" }, positionals: ["fix tests"] })
	})

	it("caches upstream project-trust overrides for trust-aware extensions", () => {
		populateCliArgs(["--approve"])
		expect(getParsedCliArgs()).toEqual({ options: { approve: true }, positionals: [] })

		populateCliArgs(["--no-approve"])
		expect(getParsedCliArgs()).toEqual({ options: { "no-approve": true }, positionals: [] })
	})

	it("reuses the cached parse across calls", () => {
		populateCliArgs(["--multi-model"])
		expect(getParsedCliArgs()).toEqual({ options: { "multi-model": true }, positionals: [] })
		// Subsequent calls return the same cached result without re-parsing.
		expect(getParsedCliArgs()).toEqual({ options: { "multi-model": true }, positionals: [] })
	})
})

describe("boolean =-form normalization", () => {
	it('enables --yolo=true (previously the string "true" — silently ignored)', () => {
		populateCliArgs(["--yolo=true", "fix tests"])
		expect(getParsedCliArgs().options.yolo).toBe(true)
	})

	it("disables on --yolo=false and keeps the bare flag true", () => {
		populateCliArgs(["--yolo=false", "fix tests"])
		expect(getParsedCliArgs().options.yolo).toBe(false)
		populateCliArgs(["--yolo", "fix tests"])
		expect(getParsedCliArgs().options.yolo).toBe(true)
	})

	it("normalizes every boolean flag's =-form", () => {
		populateCliArgs(["--yolo=true", "--plan=false"])
		expect(getParsedCliArgs().options.yolo).toBe(true)
		expect(getParsedCliArgs().options.plan).toBe(false)
	})

	it("rejects non-boolean =-values for boolean flags", () => {
		expect(() => populateCliArgs(["--yolo=1", "fix tests"])).toThrow(
			/--yolo expects a boolean \(=true or =false\); got --yolo="1"/,
		)
	})
})

describe("cacheable option coverage", () => {
	it("every CACHEABLE_OPTION_NAMES entry is declared in CLI_OPTIONS", () => {
		// parseCliArgs dereferences CLI_OPTIONS[key].type for each of these;
		// a name missing from the catalog is a startup crash, not a silent
		// miss, so the invariant is enforced here.
		const missing = CACHEABLE_OPTION_NAMES.filter((name) => !CLI_OPTIONS[name])
		expect(missing).toEqual([])
	})
})
