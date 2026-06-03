import { describe, expect, it } from "vitest"
import {
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
