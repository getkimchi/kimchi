import { describe, expect, it } from "vitest"
import { parseModeString, resolveMode } from "./mode.js"

describe("parseModeString", () => {
	it("returns mode for known strings", () => {
		expect(parseModeString("default")).toBe("default")
		expect(parseModeString("plan")).toBe("plan")
		expect(parseModeString("auto")).toBe("auto")
		expect(parseModeString("yolo")).toBe("yolo")
	})

	it("yolo mode is recognized", () => {
		expect(parseModeString("yolo")).toBe("yolo")
		expect(parseModeString("YOLO")).toBe("yolo")
		expect(parseModeString("Yolo")).toBe("yolo")
	})

	it("is case-insensitive", () => {
		expect(parseModeString("AUTO")).toBe("auto")
		expect(parseModeString("Plan")).toBe("plan")
	})

	it("returns undefined for unknown/empty", () => {
		expect(parseModeString("unknown")).toBeUndefined()
		expect(parseModeString(undefined)).toBeUndefined()
		expect(parseModeString("")).toBeUndefined()
	})
})

describe("resolveMode", () => {
	it("flag beats env and config", () => {
		const r = resolveMode({ flag: "auto", env: "plan", config: "default" })
		expect(r).toEqual({ mode: "auto", source: "flag" })
	})

	it("env beats config", () => {
		const r = resolveMode({ flag: undefined, env: "plan", config: "default" })
		expect(r).toEqual({ mode: "plan", source: "env" })
	})

	it("config is the floor", () => {
		const r = resolveMode({ flag: undefined, env: undefined, config: "auto" })
		expect(r).toEqual({ mode: "auto", source: "config" })
	})

	it("invalid env string is ignored", () => {
		const r = resolveMode({ flag: undefined, env: "garbage", config: "default" })
		expect(r.mode).toBe("default")
		expect(r.source).toBe("config")
	})
})
