import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "./config.js"

let tmpCwd: string

beforeEach(() => {
	tmpCwd = mkdtempSync(join(tmpdir(), "kimchi-perm-test-"))
})

afterEach(() => {
	rmSync(tmpCwd, { recursive: true, force: true })
})

describe("loadConfig merging", () => {
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

		const { loaded, errors } = loadConfig({ cwd: tmpCwd })
		expect(errors).toEqual([])
		expect(loaded.config.defaultMode).toBe("yolo")
	})
})
