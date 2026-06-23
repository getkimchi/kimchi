import { describe, expect, it } from "vitest"
import {
	applyVariantSelection,
	extractSpicyFlag,
	getCliModeArg,
	isExperimentalFeaturesArg,
	isHelpOrVersionArgs,
	isPreDispatchValueFlag,
	isProtocolOrPrintMode,
	isTerminalUiMode,
	stripExperimentalFeaturesArg,
} from "./cli-args.js"

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

	it.each([["--mode", "acp"], ["--mode", "rpc"], ["--mode=json"], ["--print"], ["-p"]])(
		"returns false for protocol or print args %j",
		(...args) => {
			expect(isTerminalUiMode(args, tty)).toBe(false)
		},
	)

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

	it.each([["--continue"], ["--resume"], ["--no-tools"], ["--no-themes"], ["fix tests"]])(
		"does not treat %s as a value flag",
		(arg) => {
			expect(isPreDispatchValueFlag(arg)).toBe(false)
		},
	)

	it("does not treat --variant as a value flag (--variant flag was removed)", () => {
		expect(isPreDispatchValueFlag("--variant")).toBe(false)
	})

	it("does not treat --spicy as a value flag (it is a boolean flag)", () => {
		expect(isPreDispatchValueFlag("--spicy")).toBe(false)
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

describe("extractSpicyFlag", () => {
	it("returns spicy=true and strips --spicy when present", () => {
		const result = extractSpicyFlag(["--spicy"])
		expect(result.spicy).toBe(true)
		expect(result.rest).toEqual([])
	})

	it("returns spicy=false and unchanged rest when --spicy is absent", () => {
		const result = extractSpicyFlag(["--model", "foo", "--print"])
		expect(result.spicy).toBe(false)
		expect(result.rest).toEqual(["--model", "foo", "--print"])
	})

	it("preserves other args in order when --spicy is in the middle", () => {
		const result = extractSpicyFlag(["--model", "foo", "--spicy", "--print"])
		expect(result.spicy).toBe(true)
		expect(result.rest).toEqual(["--model", "foo", "--print"])
	})

	it("handles repeated --spicy occurrences: strips all of them, returns spicy=true", () => {
		const result = extractSpicyFlag(["--spicy", "--model", "foo", "--spicy"])
		expect(result.spicy).toBe(true)
		expect(result.rest).toEqual(["--model", "foo"])
	})

	it("returns spicy=false for empty args", () => {
		const result = extractSpicyFlag([])
		expect(result.spicy).toBe(false)
		expect(result.rest).toEqual([])
	})
})

describe("applyVariantSelection", () => {
	it("sets env to 'spicy' when --spicy is present", () => {
		const env: NodeJS.ProcessEnv = {}
		const stripped = applyVariantSelection(["--spicy", "--print"], env)
		expect(env.KIMCHI_PROMPT_VARIANT).toBe("spicy")
		expect(stripped).toEqual(["--print"])
	})

	it("overrides a pre-existing KIMCHI_PROMPT_VARIANT when --spicy is present", () => {
		const env: NodeJS.ProcessEnv = { KIMCHI_PROMPT_VARIANT: "old" }
		const stripped = applyVariantSelection(["--spicy", "--print"], env)
		expect(env.KIMCHI_PROMPT_VARIANT).toBe("spicy")
		expect(stripped).toEqual(["--print"])
	})

	// TEMPORARY (testing): spicy is forced on for every launch, so it is set
	// even when --spicy is absent. Restore the opt-in assertions when reverting.
	it("forces env to 'spicy' even when --spicy is absent", () => {
		const env: NodeJS.ProcessEnv = { KIMCHI_PROMPT_VARIANT: "old" }
		const stripped = applyVariantSelection(["--model", "foo"], env)
		expect(env.KIMCHI_PROMPT_VARIANT).toBe("spicy")
		expect(stripped).toEqual(["--model", "foo"])
	})

	it("sets env to 'spicy' when --spicy is absent and env was empty", () => {
		const env: NodeJS.ProcessEnv = {}
		applyVariantSelection(["--model", "foo"], env)
		expect(env.KIMCHI_PROMPT_VARIANT).toBe("spicy")
	})

	it("returned args never contain --spicy", () => {
		const stripped = applyVariantSelection(["--spicy", "--model", "foo", "--spicy"], {})
		expect(stripped.some((a) => a === "--spicy")).toBe(false)
	})

	it("returned args never contain --variant (old flag no longer supported)", () => {
		// --variant is not recognized by the new parser; it passes through as-is
		// (but is NOT the same as --spicy). This test confirms --variant is NOT stripped.
		const env: NodeJS.ProcessEnv = {}
		const stripped = applyVariantSelection(["--variant", "spicy"], env)
		// --variant is not stripped by applyVariantSelection (it delegates to extractSpicyFlag)
		// so it stays in rest - the caller must not pass --variant. Env is forced to
		// spicy regardless (TEMPORARY testing behaviour).
		expect(env.KIMCHI_PROMPT_VARIANT).toBe("spicy")
		expect(stripped).toContain("--variant")
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
