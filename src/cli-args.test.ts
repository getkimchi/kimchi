import { describe, expect, it } from "vitest"
import { getCliModeArg, isHelpOrVersionArgs, isPreDispatchValueFlag } from "./cli-args.js"

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
