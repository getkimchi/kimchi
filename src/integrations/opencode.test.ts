import type { execFileSync as ExecFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TEST_MODELS } from "./__fixtures__/models.js"
import {
	buildUpdatedPlugins,
	compareSemverGte,
	extractVersionFromPluginName,
	getOpenCodeVersion,
	isPluginArraySupported,
} from "./opencode.js"
import { byId } from "./registry.js"

type ExecFile = typeof ExecFileSync

describe("compareSemverGte", () => {
	it("returns true for equal versions", () => {
		expect(compareSemverGte("1.14.0", "1.14.0")).toBe(true)
	})
	it("returns true for larger versions", () => {
		expect(compareSemverGte("1.14.1", "1.14.0")).toBe(true)
		expect(compareSemverGte("1.15.0", "1.14.0")).toBe(true)
		expect(compareSemverGte("2.0.0", "1.14.0")).toBe(true)
	})
	it("returns false for smaller versions", () => {
		expect(compareSemverGte("1.13.99", "1.14.0")).toBe(false)
		expect(compareSemverGte("0.99.0", "1.14.0")).toBe(false)
	})
	it("returns false for null/empty/garbage input — falls back to legacy plugin format", () => {
		expect(compareSemverGte(null, "1.14.0")).toBe(false)
		expect(compareSemverGte("", "1.14.0")).toBe(false)
		expect(compareSemverGte("not-a-version", "1.14.0")).toBe(false)
	})
	it("ignores prerelease/build suffixes (matches Go semver.GreaterThan/Equal-on-Major.Minor.Patch)", () => {
		expect(compareSemverGte("1.14.0-beta.1", "1.14.0")).toBe(true)
		expect(compareSemverGte("1.14.0+build.5", "1.14.0")).toBe(true)
	})
})

describe("extractVersionFromPluginName", () => {
	it("returns the suffix after @", () => {
		expect(extractVersionFromPluginName("@kimchi-dev/opencode-kimchi@1.14.0")).toBe("1.14.0")
		expect(extractVersionFromPluginName("@kimchi-dev/opencode-kimchi@latest")).toBe("latest")
	})
	it("returns null for the bare package name (no version pin)", () => {
		expect(extractVersionFromPluginName("@kimchi-dev/opencode-kimchi")).toBeNull()
	})
	it("returns null for unrelated plugins", () => {
		expect(extractVersionFromPluginName("@other/plugin@1.0.0")).toBeNull()
	})
})

describe("getOpenCodeVersion", () => {
	it("parses out the SemVer when opencode --version succeeds", () => {
		const exec = vi.fn().mockReturnValue("opencode v1.14.2\nbuilt with bun\n") as unknown as ExecFile
		expect(getOpenCodeVersion(exec)).toBe("1.14.2")
	})
	it("handles output without the leading v", () => {
		const exec = vi.fn().mockReturnValue("opencode 1.13.0") as unknown as ExecFile
		expect(getOpenCodeVersion(exec)).toBe("1.13.0")
	})
	it("returns null when the binary is missing", () => {
		const exec = vi.fn().mockImplementation(() => {
			throw new Error("ENOENT")
		}) as unknown as ExecFile
		expect(getOpenCodeVersion(exec)).toBeNull()
	})
	it("returns null on unexpected output", () => {
		const exec = vi.fn().mockReturnValue("garbage\n") as unknown as ExecFile
		expect(getOpenCodeVersion(exec)).toBeNull()
	})
})

describe("isPluginArraySupported", () => {
	it("respects an explicit version override (used by tests + writer)", () => {
		expect(isPluginArraySupported("1.14.0")).toBe(true)
		expect(isPluginArraySupported("1.13.99")).toBe(false)
		expect(isPluginArraySupported(null)).toBe(false)
	})
})

describe("buildUpdatedPlugins", () => {
	const KIMCHI = "@kimchi-dev/opencode-kimchi"

	it("inserts a Kimchi entry when none exists, using latestVersion", () => {
		const r = buildUpdatedPlugins({ plugins: [], telemetryEnabled: false, latestVersion: "1.14.0" })
		expect(r.skippedKimchiPlugin).toBe(false)
		expect(r.plugins).toEqual([[`${KIMCHI}@1.14.0`, {}]])
	})
	it("preserves unrelated plugins and replaces only the Kimchi entry", () => {
		const existing = [
			["@other/plugin@1.0.0", { foo: "bar" }],
			[`${KIMCHI}@1.10.0`, { stale: true }],
		]
		const r = buildUpdatedPlugins({ plugins: existing, telemetryEnabled: false, latestVersion: "1.14.5" })
		expect(r.plugins).toEqual([
			["@other/plugin@1.0.0", { foo: "bar" }],
			[`${KIMCHI}@1.14.5`, {}],
		])
	})
	it("falls back to the existing Kimchi version when npm is unavailable", () => {
		const existing = [[`${KIMCHI}@1.13.0`, {}]]
		const r = buildUpdatedPlugins({ plugins: existing, telemetryEnabled: false, latestVersion: null })
		expect(r.plugins).toEqual([[`${KIMCHI}@1.13.0`, {}]])
		expect(r.skippedKimchiPlugin).toBe(false)
	})
	it("skips the Kimchi plugin when there's no version anywhere (npm + no prior entry)", () => {
		const r = buildUpdatedPlugins({ plugins: [["@other/plugin@1.0.0"]], telemetryEnabled: false, latestVersion: null })
		expect(r.plugins).toEqual([["@other/plugin@1.0.0"]])
		expect(r.skippedKimchiPlugin).toBe(true)
	})
	it("includes telemetry endpoints when telemetry is enabled", () => {
		const r = buildUpdatedPlugins({ plugins: [], telemetryEnabled: true, latestVersion: "1.14.0" })
		const [_pkg, cfg] = r.plugins[0] as [string, Record<string, unknown>]
		expect(cfg.telemetry).toBe(true)
		expect(cfg.logsEndpoint).toBe("https://api.cast.ai/ai-optimizer/v1beta/logs:ingest")
		expect(cfg.metricsEndpoint).toBe("https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest")
	})
	it("strips the bare-package form (no version pin) like the versioned form", () => {
		const existing = [[KIMCHI, { stale: true }]]
		const r = buildUpdatedPlugins({ plugins: existing, telemetryEnabled: false, latestVersion: "1.14.0" })
		expect(r.plugins).toEqual([[`${KIMCHI}@1.14.0`, {}]])
	})
})

describe("opencode tool registration", () => {
	let scratchHome: string
	let prevHome: string | undefined

	beforeEach(() => {
		scratchHome = mkdtempSync(join(tmpdir(), "kimchi-opencode-test-"))
		prevHome = process.env.HOME
		process.env.HOME = scratchHome
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		rmSync(scratchHome, { recursive: true, force: true })
	})

	it("registers itself with the integrations registry on import", () => {
		const tool = byId("opencode")
		expect(tool).toBeDefined()
		expect(tool?.binaryName).toBe("opencode")
		expect(tool?.configPath).toBe("~/.config/opencode/opencode.json")
	})

	it("write() rejects an empty API key", async () => {
		const tool = byId("opencode")
		await expect(tool?.write("global", "", TEST_MODELS)).rejects.toThrow(/API key/)
	})

	it("write() merges provider + plugin into opencode.json without clobbering unrelated keys", async () => {
		// Stub the npm probe so the test doesn't hit the live registry. We do
		// this by intercepting global fetch — opencode.ts uses fetch() not
		// node:https — and returning a stable version. We also stub
		// execFileSync via an env hack: the writer will fall through to
		// !isPluginArraySupported() and write the legacy string format,
		// which is fine because we assert on $schema/provider/model below
		// and not on plugin shape.
		const originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ version: "1.14.0" }),
		}) as unknown as typeof fetch

		try {
			const path = `${scratchHome}/.config/opencode/opencode.json`
			mkdirSync(`${scratchHome}/.config/opencode`, { recursive: true })
			writeFileSync(path, JSON.stringify({ theme: "dark", provider: { other: { keep: true } } }), "utf-8")

			const tool = byId("opencode")
			await tool?.write("global", "test-key-123", TEST_MODELS)

			const written = JSON.parse(readFileSync(path, "utf-8"))
			expect(written.theme).toBe("dark")
			expect(written.$schema).toBe("https://opencode.ai/config.json")
			expect(written.provider.other).toEqual({ keep: true })
			expect(written.provider.kimchi).toBeDefined()
			expect((written.provider.kimchi as { options: { apiKey: string } }).options.apiKey).toBe("test-key-123")
			expect(written.model).toBe("kimchi/kimi-k2.6")
			expect(written.compaction).toEqual({ auto: true })
		} finally {
			globalThis.fetch = originalFetch
		}
	})
})
