import { describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { readTrustedReviewSettings } from "./settings.js"

describe("trusted review settings", () => {
	it("defaults to no policy additions or check definitions", () => {
		const { api } = createExtensionApi()
		expect(readTrustedReviewSettings(api)).toEqual({ requiredLenses: [], checkDefinitions: [] })
	})

	it("validates required lenses and normalizes minimal check definitions", () => {
		const { api } = createExtensionApi()
		api.getSettings = () =>
			({
				review: {
					requiredLenses: [{ id: "security", reason: "Required for authentication changes." }],
					checks: [{ id: "test", kind: "test", command: "pnpm test" }],
				},
			}) as never
		expect(readTrustedReviewSettings(api)).toEqual({
			requiredLenses: [{ id: "security", reason: "Required for authentication changes." }],
			checkDefinitions: [
				{
					id: "test",
					kind: "test",
					command: "pnpm test",
					cwd: ".",
					builds: false,
					toolchain: "unspecified",
					dependencies: [],
				},
			],
		})
	})

	it("trims valid policy and check fields once at the trusted boundary", () => {
		const { api } = createExtensionApi()
		api.getSettings = () =>
			({
				review: {
					requiredLenses: [{ id: " security ", reason: "  Required for auth changes.  " }],
					checks: [
						{
							id: " test ",
							kind: "test",
							command: " pnpm test ",
							cwd: " . ",
							toolchain: " node 22 ",
							dependencies: [" pnpm-lock.yaml "],
						},
					],
				},
			}) as never
		expect(readTrustedReviewSettings(api)).toEqual({
			requiredLenses: [{ id: "security", reason: "Required for auth changes." }],
			checkDefinitions: [
				{
					id: "test",
					kind: "test",
					command: "pnpm test",
					cwd: ".",
					builds: false,
					toolchain: "node 22",
					dependencies: ["pnpm-lock.yaml"],
				},
			],
		})
	})

	const invalidShapes: Array<{ name: string; review: unknown }> = [
		{ name: "reason whitespace", review: { requiredLenses: [{ id: "spec", reason: "   " }] } },
		{ name: "reason NUL", review: { requiredLenses: [{ id: "spec", reason: "bad\0reason" }] } },
		{ name: "id whitespace", review: { checks: [{ id: "  ", kind: "test", command: "true" }] } },
		{ name: "command NUL", review: { checks: [{ id: "test", kind: "test", command: "bad\0command" }] } },
		{ name: "cwd whitespace", review: { checks: [{ id: "test", kind: "test", command: "true", cwd: "  " }] } },
		{
			name: "dependency whitespace",
			review: { checks: [{ id: "test", kind: "test", command: "true", dependencies: ["  "] }] },
		},
		{
			name: "dependency NUL",
			review: { checks: [{ id: "test", kind: "test", command: "true", dependencies: ["bad\0path"] }] },
		},
	]

	it.each(invalidShapes)("rejects $name", ({ review }) => {
		const { api } = createExtensionApi()
		api.getSettings = () => ({ review }) as never
		expect(() => readTrustedReviewSettings(api)).toThrow()
	})

	it("rejects invalid policies instead of treating reviewed content as settings", () => {
		const { api } = createExtensionApi()
		api.getSettings = () => ({ review: { requiredLenses: [{ id: "unknown", reason: "bad" }] } }) as never
		expect(() => readTrustedReviewSettings(api)).toThrow("Unknown review lens")
		api.getSettings = () => ({ review: { checks: [{ id: "a", kind: "test", command: "true" }] } }) as never
		api.getSettings = () => ({ review: { checks: [{ id: "bad id", kind: "test", command: "true" }] } }) as never
		expect(() => readTrustedReviewSettings(api)).toThrow("invalid or duplicated")
	})
})
