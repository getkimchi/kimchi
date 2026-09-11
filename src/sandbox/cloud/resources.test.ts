import { describe, expect, it } from "vitest"
import {
	byteQuantityToBytes,
	cpuQuantityToMillicores,
	resolveWorkspaceResources,
	WorkspaceResourcesError,
} from "./resources.js"

describe("resolveWorkspaceResources", () => {
	it("returns undefined for undefined or empty config", () => {
		expect(resolveWorkspaceResources(undefined)).toBeUndefined()
		expect(resolveWorkspaceResources({})).toBeUndefined()
	})

	it("passes through valid quantities verbatim", () => {
		expect(resolveWorkspaceResources({ cpu: "250m", memory: "1Gi", pvcSize: "20Gi" })).toEqual({
			cpu: "250m",
			memory: "1Gi",
			pvcSize: "20Gi",
		})
	})

	it("trims surrounding whitespace but rejects internal whitespace (a typo must not silently change the value)", () => {
		expect(resolveWorkspaceResources({ cpu: " 250m ", memory: "\t1Gi\n" })).toEqual({ cpu: "250m", memory: "1Gi" })
		expect(() => resolveWorkspaceResources({ cpu: "250 m" })).toThrowError(WorkspaceResourcesError)
		expect(() => resolveWorkspaceResources({ memory: "1 Gi" })).toThrowError(WorkspaceResourcesError)
		expect(() => resolveWorkspaceResources({ pvcSize: "2 0 Gi" })).toThrowError(WorkspaceResourcesError)
	})

	it("accepts every suffix family, plain numbers, fractions and exponents", () => {
		expect(resolveWorkspaceResources({ cpu: "500m" })).toEqual({ cpu: "500m" })
		expect(resolveWorkspaceResources({ cpu: "2" })).toEqual({ cpu: "2" })
		expect(resolveWorkspaceResources({ cpu: "0.25" })).toEqual({ cpu: "0.25" })
		expect(resolveWorkspaceResources({ cpu: ".5" })).toEqual({ cpu: ".5" })
		expect(resolveWorkspaceResources({ cpu: "2500n" })).toEqual({ cpu: "2500n" })
		expect(resolveWorkspaceResources({ cpu: "2500u" })).toEqual({ cpu: "2500u" })
		expect(resolveWorkspaceResources({ memory: "128k" })).toEqual({ memory: "128k" })
		expect(resolveWorkspaceResources({ memory: "128Ki" })).toEqual({ memory: "128Ki" })
		expect(resolveWorkspaceResources({ memory: "2M" })).toEqual({ memory: "2M" })
		expect(resolveWorkspaceResources({ memory: "2Mi" })).toEqual({ memory: "2Mi" })
		expect(resolveWorkspaceResources({ pvcSize: "1T" })).toEqual({ pvcSize: "1T" })
		expect(resolveWorkspaceResources({ pvcSize: "1Ti" })).toEqual({ pvcSize: "1Ti" })
		expect(resolveWorkspaceResources({ pvcSize: "1P" })).toEqual({ pvcSize: "1P" })
		expect(resolveWorkspaceResources({ pvcSize: "1Pi" })).toEqual({ pvcSize: "1Pi" })
		expect(resolveWorkspaceResources({ pvcSize: "1E" })).toEqual({ pvcSize: "1E" })
		expect(resolveWorkspaceResources({ pvcSize: "1Ei" })).toEqual({ pvcSize: "1Ei" })
		expect(resolveWorkspaceResources({ memory: "1e9" })).toEqual({ memory: "1e9" })
		expect(resolveWorkspaceResources({ memory: "1E3" })).toEqual({ memory: "1E3" })
	})

	it("omits unset fields (inherit org policy)", () => {
		expect(resolveWorkspaceResources({ memory: "1Gi" })).toEqual({ memory: "1Gi" })
	})

	it.each([
		"1Gii",
		"half a cpu",
		"500mi",
		"10meg",
		"m",
		"",
		"Gi",
		"-1Gi",
		"1.2.3",
		"--1",
		"1xGi",
		// exponent and suffix are mutually exclusive — the server rejects these
		"1e3m",
		"1E3Gi",
	])("rejects invalid quantity %j naming the field and value", (bad) => {
		expect(() => resolveWorkspaceResources({ cpu: bad })).toThrowError(WorkspaceResourcesError)
		try {
			resolveWorkspaceResources({ pvcSize: bad })
		} catch (err) {
			expect(err).toBeInstanceOf(WorkspaceResourcesError)
			expect((err as Error).message).toContain("pvcSize")
			expect((err as Error).message).toContain(bad)
		}
	})

	it.each(["0", "0m", "0.0Gi", "0e3"])("rejects non-positive quantity %j with a positivity message", (zero) => {
		expect(() => resolveWorkspaceResources({ memory: zero })).toThrowError(/must be positive/)
	})

	it("a bad value in one field does not hide a good value in another field's error", () => {
		expect(() => resolveWorkspaceResources({ cpu: "250m", memory: "bogus" })).toThrowError(/memory/)
	})
})

describe("cpuQuantityToMillicores", () => {
	it.each<[string, number]>([
		["200m", 200],
		["250m", 250],
		["1", 1000],
		["1.5", 1500],
		["0.25", 250],
		[".5", 500],
		["1e1", 10000],
		["2k", 2_000_000],
		["2500n", 0],
	])("parses %j into %d millicores", (raw, expected) => {
		expect(cpuQuantityToMillicores(raw)).toBe(expected)
	})

	it("returns undefined for absent, non-string, or invalid values", () => {
		expect(cpuQuantityToMillicores(undefined)).toBeUndefined()
		expect(cpuQuantityToMillicores(200)).toBeUndefined()
		expect(cpuQuantityToMillicores("banana")).toBeUndefined()
		expect(cpuQuantityToMillicores("")).toBeUndefined()
	})

	it("trims surrounding whitespace like the config path", () => {
		expect(cpuQuantityToMillicores(" 200m ")).toBe(200)
	})
})

describe("byteQuantityToBytes", () => {
	it.each<[string, number]>([
		["512Mi", 536870912],
		["10Gi", 10737418240],
		["1.5Gi", 1610612736],
		["1G", 1_000_000_000],
		["128Ki", 131072],
		["1e3", 1000],
		["2048", 2048],
	])("parses %j into %d bytes", (raw, expected) => {
		expect(byteQuantityToBytes(raw)).toBe(expected)
	})

	it("returns undefined for absent, non-string, or invalid values", () => {
		expect(byteQuantityToBytes(undefined)).toBeUndefined()
		expect(byteQuantityToBytes(1024)).toBeUndefined()
		expect(byteQuantityToBytes("half a gb")).toBeUndefined()
	})
})
