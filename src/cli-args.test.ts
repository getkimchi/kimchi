import { describe, expect, it } from "vitest"
import { getCliModeArg } from "./cli-args.js"

describe("getCliModeArg", () => {
	it("reads --mode value", () => {
		expect(getCliModeArg(["--model", "cast/gpt-5", "--mode", "json"])).toBe("json")
	})

	it("reads --mode=value", () => {
		expect(getCliModeArg(["--mode=rpc"])).toBe("rpc")
	})

	it("returns undefined when mode is absent or missing a value", () => {
		expect(getCliModeArg([])).toBeUndefined()
		expect(getCliModeArg(["--mode"])).toBeUndefined()
	})
})
