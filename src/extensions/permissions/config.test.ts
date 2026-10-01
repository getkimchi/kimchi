import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../project-scope-trust.js"
import { loadConfig } from "./config.js"

let tmpCwd: string

beforeEach(() => {
	tmpCwd = mkdtempSync(join(tmpdir(), "kimchi-perm-test-"))
	resetProjectScopeTrustForTests()
})

afterEach(() => {
	rmSync(tmpCwd, { recursive: true, force: true })
})

describe("loadConfig merging", () => {
	it("inherits user budget through project and local files that omit it", async () => {
		const userDir = join(tmpCwd, ".config", "kimchi", "harness")
		mkdirSync(userDir, { recursive: true })
		writeFileSync(join(userDir, "permissions.json"), JSON.stringify({ classifierMaxTotalMs: 17000 }))
		mkdirSync(join(tmpCwd, ".kimchi"), { recursive: true })
		writeFileSync(join(tmpCwd, ".kimchi", "permissions.json"), "{}")
		writeFileSync(join(tmpCwd, ".kimchi", "permissions.local.json"), "{}")
		vi.doMock("node:os", async (importOriginal) => ({
			...(await importOriginal<typeof import("node:os")>()),
			homedir: () => tmpCwd,
		}))
		vi.resetModules()
		try {
			const isolatedConfig = await import("./config.js")
			// resetModules re-instantiates the trust gate too — trust the cwd
			// through the same isolated registry the config reads.
			const isolatedTrust = await import("../../project-scope-trust.js")
			isolatedTrust.setProjectScopeTrusted(tmpCwd, true)
			expect(isolatedConfig.loadConfig({ cwd: tmpCwd }).loaded.config.classifierMaxTotalMs).toBe(17000)
			writeFileSync(join(tmpCwd, ".kimchi", "permissions.json"), JSON.stringify({ classifierMaxTotalMs: 12000 }))
			expect(isolatedConfig.loadConfig({ cwd: tmpCwd }).loaded.config.classifierMaxTotalMs).toBe(12000)
		} finally {
			vi.doUnmock("node:os")
			vi.resetModules()
		}
	})

	it.each([undefined, 12000])("fills or accepts the classifier total budget (%s)", (budget) => {
		const path = join(tmpCwd, "override.json")
		writeFileSync(path, JSON.stringify({ classifierMaxTotalMs: budget }))
		const { loaded, errors } = loadConfig({ cwd: tmpCwd, cliConfigPath: path })
		expect(errors).toEqual([])
		expect(loaded.config.classifierMaxTotalMs).toBe(budget ?? 25000)
	})

	it("uses explicit local budgets before project budgets and preserves inheritance through sparse local files", () => {
		mkdirSync(join(tmpCwd, ".kimchi"), { recursive: true })
		writeFileSync(join(tmpCwd, ".kimchi", "permissions.json"), JSON.stringify({ classifierMaxTotalMs: 12000 }))
		const local = join(tmpCwd, ".kimchi", "permissions.local.json")
		writeFileSync(local, JSON.stringify({ classifierMaxTotalMs: 6000 }))
		setProjectScopeTrusted(tmpCwd, true)
		expect(loadConfig({ cwd: tmpCwd }).loaded.config.classifierMaxTotalMs).toBe(6000)
		writeFileSync(local, JSON.stringify({ allow: ["read"] }))
		expect(loadConfig({ cwd: tmpCwd }).loaded.config.classifierMaxTotalMs).toBe(12000)
		const override = join(tmpCwd, "override.json")
		writeFileSync(override, "{}")
		expect(loadConfig({ cwd: tmpCwd, cliConfigPath: override }).loaded.config.classifierMaxTotalMs).toBe(25000)
	})

	it.each([
		{ classifierMaxTotalMs: 0 },
		{ classifierMaxTotalMs: -1 },
		{ classifierMaxTotalMs: 1.5 },
		{ classifierMaxTotalMs: "12000" },
		{ classifierMaxTotalMs: 12000, unknownSetting: true },
	])("rejects invalid budgets and unknown settings: %j", (config) => {
		const path = join(tmpCwd, "invalid.json")
		writeFileSync(path, JSON.stringify(config))
		expect(loadConfig({ cwd: tmpCwd, cliConfigPath: path }).errors).toHaveLength(1)
	})

	it("reads project config and tags rules by source", () => {
		mkdirSync(join(tmpCwd, ".kimchi"), { recursive: true })
		writeFileSync(
			join(tmpCwd, ".kimchi", "permissions.json"),
			JSON.stringify({
				defaultMode: "plan",
				allow: ["bash(git:*)"],
				deny: ["write(.env)"],
			}),
		)

		setProjectScopeTrusted(tmpCwd, true)
		const { loaded, errors } = loadConfig({ cwd: tmpCwd })
		expect(errors).toEqual([])
		expect(loaded.config.defaultMode).toBe("plan")
		expect(loaded.allowBySource.project).toContain("bash(git:*)")
		expect(loaded.denyBySource.project).toContain("write(.env)")
		expect(loaded.paths.project).toBeDefined()
	})

	it("merges local on top of project", () => {
		mkdirSync(join(tmpCwd, ".kimchi"), { recursive: true })
		writeFileSync(
			join(tmpCwd, ".kimchi", "permissions.json"),
			JSON.stringify({ defaultMode: "default", allow: ["bash(git:*)"] }),
		)
		writeFileSync(
			join(tmpCwd, ".kimchi", "permissions.local.json"),
			JSON.stringify({ defaultMode: "auto", allow: ["read(/etc/**)"] }),
		)

		setProjectScopeTrusted(tmpCwd, true)
		const { loaded } = loadConfig({ cwd: tmpCwd })
		// local overrides defaultMode
		expect(loaded.config.defaultMode).toBe("auto")
		// allow is additive
		expect(loaded.config.allow).toContain("bash(git:*)")
		expect(loaded.config.allow).toContain("read(/etc/**)")
	})

	it("cli override replaces merged config entirely", () => {
		mkdirSync(join(tmpCwd, ".kimchi"), { recursive: true })
		writeFileSync(join(tmpCwd, ".kimchi", "permissions.json"), JSON.stringify({ allow: ["bash(git:*)"] }))

		const overridePath = join(tmpCwd, "override.json")
		writeFileSync(overridePath, JSON.stringify({ defaultMode: "auto", deny: ["bash"] }))

		setProjectScopeTrusted(tmpCwd, true)
		const { loaded } = loadConfig({ cwd: tmpCwd, cliConfigPath: overridePath })
		expect(loaded.config.defaultMode).toBe("auto")
		// project allow is NOT included because cli-override replaces.
		expect(loaded.config.allow).not.toContain("bash(git:*)")
		expect(loaded.config.deny).toContain("bash")
	})

	it("reports schema validation errors but doesn't throw", () => {
		mkdirSync(join(tmpCwd, ".kimchi"), { recursive: true })
		writeFileSync(
			join(tmpCwd, ".kimchi", "permissions.json"),
			JSON.stringify({ defaultMode: "invalid", allow: ["bash"] }),
		)

		setProjectScopeTrusted(tmpCwd, true)
		const { loaded, errors } = loadConfig({ cwd: tmpCwd })
		expect(errors.length).toBeGreaterThan(0)
		// Bad file is ignored (no project rules merged).
		expect(loaded.allowBySource.project).toEqual([])
	})

	it("passes CLI flag rules through as cli source", () => {
		const { loaded } = loadConfig({
			cwd: tmpCwd,
			cliAllow: ["bash(npm test)"],
			cliDeny: ["write(.env)"],
		})
		expect(loaded.allowBySource.cli).toEqual(["bash(npm test)"])
		expect(loaded.denyBySource.cli).toEqual(["write(.env)"])
	})

	it("accepts yolo as defaultMode and round-trips it", () => {
		mkdirSync(join(tmpCwd, ".kimchi"), { recursive: true })
		writeFileSync(join(tmpCwd, ".kimchi", "permissions.json"), JSON.stringify({ defaultMode: "yolo" }))

		setProjectScopeTrusted(tmpCwd, true)
		const { loaded, errors } = loadConfig({ cwd: tmpCwd })
		expect(errors).toEqual([])
		expect(loaded.config.defaultMode).toBe("yolo")
	})

	it("ignores an untrusted repo's project and local permission files (fail closed)", () => {
		mkdirSync(join(tmpCwd, ".kimchi"), { recursive: true })
		writeFileSync(
			join(tmpCwd, ".kimchi", "permissions.json"),
			JSON.stringify({ defaultMode: "yolo", allow: ["bash(git push --force:*)"] }),
		)
		writeFileSync(join(tmpCwd, ".kimchi", "permissions.local.json"), JSON.stringify({ allow: ["read(/etc/**)"] }))

		// No setProjectScopeTrusted call: the gate stays closed, so a cloned
		// repo cannot disarm the permission layer with its own rules.
		const { loaded, errors } = loadConfig({ cwd: tmpCwd })
		expect(errors).toEqual([])
		expect(loaded.config.defaultMode).toBe("default")
		expect(loaded.config.allow).toEqual([])
		expect(loaded.allowBySource.project).toEqual([])
		expect(loaded.allowBySource.local).toEqual([])
		expect(loaded.paths.project).toBeUndefined()
		expect(loaded.paths.local).toBeUndefined()
	})
})
