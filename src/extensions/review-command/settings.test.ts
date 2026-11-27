import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { type ReviewSettingsManager, readTrustedReviewSettings } from "./settings.js"

function noEnvironment() {
	return { caches: [], toolchains: [], profiles: { repositories: {} } }
}

function source(globalReview?: unknown, projectReview?: unknown): ReviewSettingsManager {
	return {
		getGlobalSettings: () => ({ review: globalReview }) as never,
		getProjectSettings: () => ({ review: projectReview }) as never,
	}
}

function read(api: ExtensionAPI, globalReview?: unknown) {
	return readTrustedReviewSettings(api, source(globalReview))
}

describe("trusted review settings", () => {
	it("defaults to no policy additions or check definitions", () => {
		const { api } = createExtensionApi()
		expect(read(api)).toEqual({
			requiredLenses: [],
			checkDefinitions: [],
			environment: noEnvironment(),
			environmentGaps: [],
		})
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
		expect(read(api)).toEqual({
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
			environment: noEnvironment(),
			environmentGaps: [],
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
		expect(read(api)).toEqual({
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
			environment: noEnvironment(),
			environmentGaps: [],
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
		expect(() => read(api)).toThrow()
	})

	it("turns invalid environment-only settings into a typed isolated fallback", () => {
		const { api } = createExtensionApi()
		const review = { environment: { profiles: { default: { env: { SECRET: "${env:HOME}" } } } } }
		api.getSettings = () => ({ review }) as never
		expect(() => read(api, review)).not.toThrow()
		expect(read(api, review)).toMatchObject({
			environment: noEnvironment(),
			environmentGaps: [{ kind: "invalid_environment_settings", name: "review.environment" }],
		})
	})

	it("rejects invalid policies instead of treating reviewed content as settings", () => {
		const { api } = createExtensionApi()
		api.getSettings = () => ({ review: { requiredLenses: [{ id: "unknown", reason: "bad" }] } }) as never
		expect(() => read(api)).toThrow("Unknown review lens")
		api.getSettings = () => ({ review: { checks: [{ id: "bad id", kind: "test", command: "true" }] } }) as never
		expect(() => read(api)).toThrow("invalid or duplicated")
	})

	it("uses only global environment settings with a real SettingsManager and records ignored project input", () => {
		const sandbox = mkdtempSync(join(tmpdir(), "review-settings-scopes-"))
		const cwd = join(sandbox, "repo")
		const agentDir = join(sandbox, "user-agent")
		const globalEnvironment = {
			caches: [{ id: "global-cache", path: "/trusted/global-cache" }],
			toolchains: [],
			profiles: {
				default: {
					readOnlyCaches: ["global-cache"],
					privateDirs: [],
					env: { TRUST_ORIGIN: "global" },
					setup: [],
					probes: [],
				},
			},
		}
		const projectEnvironment = {
			caches: [{ id: "project-cache", path: "/untrusted/project-cache" }],
			toolchains: [{ id: "project-tools", bin: ["/untrusted/bin"] }],
			profiles: {
				default: {
					readOnlyCaches: ["project-cache"],
					privateDirs: [],
					env: { TRUST_ORIGIN: "project" },
					toolchain: "project-tools",
					setup: [{ argv: ["/bin/sh", "-c", "exit 99"], cwd: ".", timeoutMs: 1000, required: true }],
					probes: [],
				},
			},
		}
		try {
			mkdirSync(agentDir, { recursive: true })
			mkdirSync(join(cwd, ".pi"), { recursive: true })
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ review: { environment: globalEnvironment } }))
			writeFileSync(
				join(cwd, ".pi", "settings.json"),
				JSON.stringify({
					review: {
						environment: projectEnvironment,
						requiredLenses: [{ id: "operational", reason: "Existing project policy compatibility" }],
						checks: [{ id: "project-check", kind: "test", command: "printf project-check" }],
					},
				}),
			)
			const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: true })
			const { api } = createExtensionApi()
			api.getSettings = () => manager.getSettings()
			const result = readTrustedReviewSettings(api, manager)
			expect(result.environment.caches.map((cache) => cache.id)).toEqual(["global-cache"])
			expect(result.environment.profiles.default?.env).toEqual({ TRUST_ORIGIN: "global" })
			expect(result.environment.profiles.default?.setup).toEqual([])
			expect(JSON.stringify(result.environment)).not.toContain("project-cache")
			expect(result.environmentGaps).toContainEqual({
				kind: "project_environment_ignored",
				name: "review.environment",
				note: "Project-level review.environment was ignored; host caches and preparation must be configured in user-level settings.",
			})
			expect(result.requiredLenses).toEqual([{ id: "operational", reason: "Existing project policy compatibility" }])
			expect(result.checkDefinitions[0]).toMatchObject({ id: "project-check", command: "printf project-check" })
		} finally {
			rmSync(sandbox, { recursive: true, force: true })
		}
	})
})
