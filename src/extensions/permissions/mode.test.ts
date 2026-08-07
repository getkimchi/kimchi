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
	it("runtime beats flag, persisted, env and config", () => {
		const r = resolveMode({
			runtime: { mode: "yolo", source: "runtime", initiatedBy: "user" },
			flag: "plan",
			persisted: { mode: "auto", source: "runtime", initiatedBy: "user" },
			env: "default",
			config: "default",
		})
		expect(r).toEqual({ mode: "yolo", source: "runtime", initiatedBy: "user" })
	})

	it("flag beats persisted, env and config", () => {
		const r = resolveMode({
			flag: "plan",
			persisted: { mode: "auto", source: "flag", initiatedBy: "user" },
			env: "yolo",
			config: "default",
		})
		expect(r).toEqual({ mode: "plan", source: "flag", initiatedBy: "user" })
	})

	it("env beats persisted and config", () => {
		const r = resolveMode({
			persisted: { mode: "auto", source: "runtime", initiatedBy: "user" },
			env: "yolo",
			config: "default",
		})
		expect(r).toEqual({ mode: "yolo", source: "env", initiatedBy: "user" })
	})

	it("env beats config", () => {
		const r = resolveMode({
			env: "plan",
			config: "default",
		})
		expect(r).toEqual({ mode: "plan", source: "env", initiatedBy: "user" })
	})

	it("persisted beats config", () => {
		const r = resolveMode({
			persisted: { mode: "auto", source: "runtime", initiatedBy: "user" },
			config: "default",
		})
		expect(r).toEqual({ mode: "auto", source: "runtime", initiatedBy: "user" })
	})

	it("config is the floor", () => {
		const r = resolveMode({
			config: "auto",
		})
		expect(r).toEqual({ mode: "auto", source: "config", initiatedBy: "user" })
	})

	it("invalid env string is ignored", () => {
		const r = resolveMode({
			env: "garbage",
			config: "default",
		})
		expect(r.mode).toBe("default")
		expect(r.source).toBe("config")
	})
})
