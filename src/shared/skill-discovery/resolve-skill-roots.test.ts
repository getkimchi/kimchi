import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveBundledSkillsDir, resolveHarnessSkillsDir, resolveSkillRoots } from "./resolve-skill-roots.js"

describe("resolveHarnessSkillsDir", () => {
	it("points at ~/.config/kimchi/harness/skills", () => {
		expect(resolveHarnessSkillsDir("/home/alice")).toBe(join("/home/alice", ".config", "kimchi", "harness", "skills"))
	})
})

describe("resolveBundledSkillsDir", () => {
	it("finds the in-repo resources/skills when running from the source tree", () => {
		const expected = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "skills")
		expect(resolveBundledSkillsDir("/nonexistent-home")).toBe(expected)
	})
})

describe("resolveSkillRoots", () => {
	let home: string
	let cwd: string

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "skill-home-"))
		cwd = mkdtempSync(join(tmpdir(), "skill-cwd-"))
	})

	afterEach(() => {
		rmSync(home, { recursive: true, force: true })
		rmSync(cwd, { recursive: true, force: true })
	})

	it("orders weakest-first: bundled, harness, config, project", () => {
		mkdirSync(join(home, ".config", "kimchi", "harness", "skills"), { recursive: true })
		mkdirSync(join(cwd, ".pi", "agent", "skills"), { recursive: true })
		mkdirSync(join(cwd, ".kimchi", "skills"), { recursive: true })

		const kinds = resolveSkillRoots({ cwd, homeDir: home, bundledDir: join(home, "bundled") }).map((r) => r.kind)
		expect(kinds).toEqual(["bundled", "harness", "config", "project"])
	})

	it("maps `.config/` config paths under home and other relative paths under cwd", () => {
		mkdirSync(join(home, ".config", "some", "skills"), { recursive: true })
		mkdirSync(join(cwd, ".local", "skills"), { recursive: true })

		const roots = resolveSkillRoots({
			cwd,
			homeDir: home,
			bundledDir: null,
			configPaths: [join(".config", "some", "skills"), join(".local", "skills")],
		})
		const configDirs = roots.filter((r) => r.kind === "config").map((r) => r.dir)
		expect(configDirs).toEqual([join(home, ".config", "some", "skills"), join(cwd, ".local", "skills")])
	})

	it("keeps absolute config paths as-is", () => {
		const abs = join(home, "absolute-skills")
		mkdirSync(abs, { recursive: true })

		const roots = resolveSkillRoots({ cwd, homeDir: home, bundledDir: null, configPaths: [abs] })
		expect(roots.find((r) => r.kind === "config")?.dir).toBe(abs)
	})

	it("skips config dirs that do not exist but always includes the harness dir", () => {
		const roots = resolveSkillRoots({ cwd, homeDir: home, bundledDir: null })
		expect(roots.map((r) => r.kind)).toEqual(["harness"])
	})

	it("discovers the project root via ancestor .kimchi/skills search", () => {
		mkdirSync(join(cwd, ".kimchi", "skills"), { recursive: true })
		const nested = join(cwd, "src", "deep")
		mkdirSync(nested, { recursive: true })

		const project = resolveSkillRoots({ cwd: nested, homeDir: home, bundledDir: null }).find(
			(r) => r.kind === "project",
		)
		expect(project?.dir).toBe(join(cwd, ".kimchi", "skills"))
	})

	it("bundledDir: null disables the bundled root", () => {
		const roots = resolveSkillRoots({ cwd, homeDir: home, bundledDir: null })
		expect(roots.some((r) => r.kind === "bundled")).toBe(false)
	})

	it("bundledDir override wins over auto-resolution", () => {
		const override = join(home, "custom-bundled")
		const roots = resolveSkillRoots({ cwd, homeDir: home, bundledDir: override })
		expect(roots.find((r) => r.kind === "bundled")?.dir).toBe(override)
	})
})
