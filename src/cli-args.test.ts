import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs as parsePiArgs } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import {
	CACHEABLE_OPTION_NAMES,
	CLI_OPTIONS,
	dropRetiredMultiModelArg,
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
	parseCliArgs,
	populateCliArgs,
	resolveAdditionalSkillPaths,
	resolveBashProcessLimitSeconds,
	stripAdditionalSkillsPathsArg,
	stripExperimentalFeaturesArg,
} from "./cli-args.js"
import { normalizeAtFileArgs } from "./fs-paths.js"

describe("value-flag parsing", () => {
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
		["--additionalSkillsPaths"],
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

describe("additionalSkillsPaths parsing", () => {
	it("collects repeated flags into an ordered array", () => {
		populateCliArgs(["--additionalSkillsPaths", "/tmp/first", "--additionalSkillsPaths", "/tmp/second"])
		expect(getParsedCliArgs().options.additionalSkillsPaths).toEqual(["/tmp/first", "/tmp/second"])
		populateCliArgs([])
	})

	it("accepts the --flag=value form and mixes it with the spaced form", () => {
		populateCliArgs(["--additionalSkillsPaths=/tmp/first", "--additionalSkillsPaths", "/tmp/second"])
		expect(getParsedCliArgs().options.additionalSkillsPaths).toEqual(["/tmp/first", "/tmp/second"])
		populateCliArgs([])
	})

	it("does not split comma-joined values and stays undefined when absent", () => {
		// No comma-separated parsing: one flag is one path.
		populateCliArgs(["--additionalSkillsPaths", "/a,/b"])
		expect(getParsedCliArgs().options.additionalSkillsPaths).toEqual(["/a,/b"])
		populateCliArgs([])
		expect(getParsedCliArgs().options.additionalSkillsPaths).toBeUndefined()
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

describe("dropRetiredMultiModelArg", () => {
	// Kimchi Studio launches new terminal sessions this way; they must start
	// on the default model instead of failing with "model not found".
	it.each([
		[
			["--model", "multi-model", "--plan", "fix it"],
			["--plan", "fix it"],
		],
		[["--model=multi-model", "--plan"], ["--plan"]],
	])("drops %j", (args, expected) => {
		expect(dropRetiredMultiModelArg(args)).toEqual(expected)
		expect(parseCliArgs(dropRetiredMultiModelArg(args)).options.model).toBeUndefined()
	})

	it("keeps real model selections", () => {
		const args = ["--model", "kimchi-dev/deepseek-v4.1-flash", "multi-model"]
		expect(dropRetiredMultiModelArg(args)).toEqual(args)
	})
})

describe("populateCliArgs / getParsedCliArgs", () => {
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
		populateCliArgs(["--approve"])
		expect(getParsedCliArgs()).toEqual({ options: { approve: true }, positionals: [] })
		// Subsequent calls return the same cached result without re-parsing.
		expect(getParsedCliArgs()).toEqual({ options: { approve: true }, positionals: [] })
	})
})

describe("resolveBashProcessLimitSeconds", () => {
	it("parses --bash-process-limit as a positive integer", () => {
		populateCliArgs(["--bash-process-limit", "900"])
		expect(getParsedCliArgs().options["bash-process-limit"]).toBe("900")
		expect(resolveBashProcessLimitSeconds()).toBe(900)
	})

	it("returns undefined when the flag is absent", () => {
		populateCliArgs([])
		expect(resolveBashProcessLimitSeconds()).toBeUndefined()
	})

	for (const bad of ["abc", "0", "-5", "12.5", ""]) {
		it(`rejects ${JSON.stringify(bad)} at parse time with a clear error`, () => {
			expect(() => populateCliArgs(["--bash-process-limit", bad])).toThrow(/Invalid --bash-process-limit/)
		})
	}
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

describe("stripAdditionalSkillsPathsArg", () => {
	it.each([
		["empty args stay empty", [], []],
		[
			"no flag: args pass through unchanged",
			["--model", "cast/gpt-5", "fix tests"],
			["--model", "cast/gpt-5", "fix tests"],
		],
		["separated form is removed with its value", ["--additionalSkillsPaths", "/tmp/first"], []],
		["equals form is removed", ["--additionalSkillsPaths=/tmp/first"], []],
		[
			"multiple paths are removed across forms while the rest keeps its order",
			[
				"--additionalSkillsPaths",
				"/tmp/first",
				"--additionalSkillsPaths=/tmp/second",
				"--additionalSkillsPaths",
				"/tmp/third",
			],
			[],
		],
		[
			"existing --skill coexists and is never invented",
			["--skill", "/tmp/upstream", "--additionalSkillsPaths", "/tmp/extra"],
			["--skill", "/tmp/upstream"],
		],
		[
			"existing --skill= form coexists",
			["--additionalSkillsPaths=/tmp/extra", "--skill=/tmp/upstream"],
			["--skill=/tmp/upstream"],
		],
		[
			"unrelated tokens and prompt positionals are preserved",
			["--provider", "kimchi-dev", "--additionalSkillsPaths", "/tmp/extra", "--print", "fix tests"],
			["--provider", "kimchi-dev", "--print", "fix tests"],
		],
		[
			"a value-taking option keeps its flag-shaped value intact",
			["--additionalSkillsPaths", "/tmp/extra", "--system-prompt", "--print"],
			["--system-prompt", "--print"],
		],
		[
			"bare -- stops stripping of following tokens",
			["--additionalSkillsPaths", "/tmp/extra", "--", "--additionalSkillsPaths", "literal-positional"],
			["--", "--additionalSkillsPaths", "literal-positional"],
		],
		[
			"equals form before -- is stripped, after is not",
			["--additionalSkillsPaths=/tmp/extra", "--", "--additionalSkillsPaths=/tmp/raw"],
			["--", "--additionalSkillsPaths=/tmp/raw"],
		],
		[
			"dangling standalone flag without a value is dropped, never rewritten",
			["--model", "cast/gpt-5", "--additionalSkillsPaths"],
			["--model", "cast/gpt-5"],
		],
		[
			"dangling standalone flag before -- is dropped and the separator stays verbatim",
			["--additionalSkillsPaths", "--", "literal-positional"],
			["--", "literal-positional"],
		],
		[
			"a dangling flag followed by -- keeps the separator and later flag-shaped positionals",
			["--additionalSkillsPaths", "--", "--additionalSkillsPaths", "literal-positional"],
			["--", "--additionalSkillsPaths", "literal-positional"],
		],
		[
			"a dangling flag as another option's value stays verbatim",
			["--system-prompt", "--additionalSkillsPaths"],
			["--system-prompt", "--additionalSkillsPaths"],
		],
		[
			"a dangling flag as --system-prompt's value does not stop later stripping",
			["--system-prompt", "--additionalSkillsPaths", "--additionalSkillsPaths=/tmp/x"],
			["--system-prompt", "--additionalSkillsPaths"],
		],
		[
			"a dangling flag as an existing --skill's value stays verbatim",
			["--skill", "--additionalSkillsPaths"],
			["--skill", "--additionalSkillsPaths"],
		],
		[
			"only the exact flag name is stripped; prefixes are not",
			["--additionalSkillsPathsExtra", "/tmp/x"],
			["--additionalSkillsPathsExtra", "/tmp/x"],
		],
	])("%s", (_name, input, expected) => {
		expect(stripAdditionalSkillsPathsArg(input)).toEqual(expected)
		// Stripping is idempotent: an already-stripped argv is unchanged.
		expect(stripAdditionalSkillsPathsArg(stripAdditionalSkillsPathsArg(input))).toEqual(expected)
	})

	it("never leaves the raw flag for pi before a bare --", () => {
		// The ACP branch of cli.ts resolves appendSystemPrompt by parsing the
		// stripped argv with pi's parser, and the non-ACP branch hands the
		// stripped argv to main(). This pins the composition: after stripping,
		// upstream sees no unknown Kimchi-local flag, explicit --skill options
		// survive, and appendSystemPrompt survives.
		const raw = [
			"--additionalSkillsPaths",
			"/tmp/private-skills",
			"--append-system-prompt",
			"tail instructions",
			"--skill",
			"/tmp/upstream",
		]
		const parsed = parsePiArgs(stripAdditionalSkillsPathsArg(raw))
		expect(parsed.appendSystemPrompt).toEqual(["tail instructions"])
		expect(parsed.skills).toEqual(["/tmp/upstream"])
		expect(parsed.unknownFlags.has("additionalSkillsPaths")).toBe(false)
	})
})

describe("additionalSkillsPaths malformed-value validation", () => {
	// node:util parseArgs (strict:false) reports a terminal flag as boolean
	// `true`, `--additionalSkillsPaths=` as the empty string, and
	// `--additionalSkillsPaths --` as the path value `"--"` — each would
	// otherwise spread into ACP loader options or non-ACP discovery. The raw
	// argv must reject all three with a clear startup error.
	it.each([
		["terminal standalone flag", ["--additionalSkillsPaths"]],
		["empty equals value", ["--additionalSkillsPaths="]],
		["bare -- as the following value", ["--additionalSkillsPaths", "--"]],
	])("%s is a startup error", (_name, args) => {
		expect(() => populateCliArgs(args)).toThrow("--additionalSkillsPaths requires a path")
	})

	it.each([
		["the same token as another option's value", ["--system-prompt", "--additionalSkillsPaths"]],
		["the same token as an existing --skill's value", ["--skill", "--additionalSkillsPaths"]],
		["a token after the bare -- separator", ["--", "--additionalSkillsPaths"]],
		["a well-formed separated flag", ["--additionalSkillsPaths", "/tmp/skills"]],
		["a well-formed equals flag", ["--additionalSkillsPaths=/tmp/skills"]],
	])("%s is accepted", (_name, args) => {
		expect(() => populateCliArgs(args)).not.toThrow()
	})
})

describe("resolveAdditionalSkillPaths", () => {
	it("returns the validated parsed roots in order", () => {
		populateCliArgs(["--additionalSkillsPaths", "/tmp/first", "--additionalSkillsPaths=/tmp/second"])
		expect(resolveAdditionalSkillPaths()).toEqual(["/tmp/first", "/tmp/second"])
	})

	it("returns a typed empty array when the flag is absent", () => {
		populateCliArgs(["--model", "cast/gpt-5"])
		expect(resolveAdditionalSkillPaths()).toEqual([])
	})

	it("accepts an explicit parsed argument", () => {
		expect(resolveAdditionalSkillPaths(parseCliArgs(["--additionalSkillsPaths", "/tmp/x"]))).toEqual(["/tmp/x"])
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
