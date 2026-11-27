import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HARNESS_SKILLS_REL } from "../../agent-dir.js"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../project-scope-trust.js"
import {
	resolveBundledSkillsDir,
	resolveHarnessSkillsDir,
	resolveSkillPathsForDiscovery,
	resolveSkillRoots,
} from "./resolve-skill-roots.js"

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
		resetProjectScopeTrustForTests()
	})

	afterEach(() => {
		rmSync(home, { recursive: true, force: true })
		rmSync(cwd, { recursive: true, force: true })
	})

	it("orders weakest-first: bundled, harness, config, project", () => {
		mkdirSync(join(home, ".config", "kimchi", "harness", "skills"), { recursive: true })
		mkdirSync(join(cwd, ".pi", "agent", "skills"), { recursive: true })
		mkdirSync(join(cwd, ".kimchi", "skills"), { recursive: true })

		setProjectScopeTrusted(cwd, true)
		const kinds = resolveSkillRoots({ cwd, homeDir: home, bundledDir: join(home, "bundled") }).map((r) => r.kind)
		expect(kinds).toEqual(["bundled", "harness", "config", "project"])
	})

	it("maps `.config/` config paths under home and other relative paths under cwd", () => {
		mkdirSync(join(home, ".config", "some", "skills"), { recursive: true })
		mkdirSync(join(cwd, ".local", "skills"), { recursive: true })

		setProjectScopeTrusted(cwd, true)
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

		setProjectScopeTrusted(cwd, true)
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

	it("skips the project root while the project is untrusted (fail closed)", () => {
		mkdirSync(join(cwd, ".kimchi", "skills"), { recursive: true })

		// No setProjectScopeTrusted call: a cloned repo's .kimchi/skills must
		// not reach the system prompt.
		const roots = resolveSkillRoots({ cwd, homeDir: home, bundledDir: null })
		expect(roots.some((r) => r.kind === "project")).toBe(false)
	})

	it("includes an overridden agent dir as its own root and dedupes the default", () => {
		const customAgent = join(home, "custom-agent")
		mkdirSync(join(customAgent, "skills"), { recursive: true })

		const roots = resolveSkillRoots({ cwd, homeDir: home, bundledDir: null, agentDir: customAgent })
		expect(roots.find((r) => r.kind === "agent")?.dir).toBe(join(customAgent, "skills"))

		// Default agentDir coincides with the harness root: no "agent" root.
		const defaulted = resolveSkillRoots({ cwd, homeDir: home, bundledDir: null })
		expect(defaulted.some((r) => r.kind === "agent")).toBe(false)

		// null disables the root entirely (the always-present harness root
		// stays).
		const disabled = resolveSkillRoots({ cwd, homeDir: home, bundledDir: null, agentDir: null })
		expect(disabled.some((r) => r.kind === "agent")).toBe(false)
	})

	it("uses only an explicit agent dir's skills as the harness root", () => {
		const stage = join(home, "stage-agent")
		mkdirSync(join(home, ".config", "kimchi", "harness", "skills"), { recursive: true })
		mkdirSync(join(stage, "skills"), { recursive: true })
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", stage)
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR_DERIVED", "")
		try {
			const roots = resolveSkillRoots({ cwd, homeDir: home, bundledDir: null, configPaths: [HARNESS_SKILLS_REL] })
			expect(roots).toEqual([{ dir: join(stage, "skills"), kind: "harness" }])
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("maps extraPaths like config paths (cwd-relative roots need trust)", () => {
		mkdirSync(join(cwd, ".local", "extra-skills"), { recursive: true })
		setProjectScopeTrusted(cwd, true)

		const roots = resolveSkillRoots({ cwd, homeDir: home, bundledDir: null, extraPaths: [".local/extra-skills"] })
		const configDirs = roots.filter((r) => r.kind === "config").map((r) => r.dir)
		expect(configDirs).toContain(join(cwd, ".local", "extra-skills"))
	})

	it("skips cwd-resolved config roots while the project is untrusted", () => {
		mkdirSync(join(cwd, ".claude", "skills"), { recursive: true })
		mkdirSync(join(cwd, ".pi", "agent", "skills"), { recursive: true })
		mkdirSync(join(home, ".config", "kimchi", "harness", "skills"), { recursive: true })

		// Untrusted: the cwd-resolved .claude/skills and .pi/agent/skills default config path is
		// project-scoped and skipped; the home-resolved harness dir remains.
		const untrusted = resolveSkillRoots({ cwd, homeDir: home, bundledDir: null })
		expect(untrusted.map((r) => r.kind)).toEqual(["harness"])

		setProjectScopeTrusted(cwd, true)
		const trusted = resolveSkillRoots({ cwd, homeDir: home, bundledDir: null })
		expect(trusted.map((r) => r.kind)).toEqual(["harness", "config", "config"])
		expect(trusted.filter((r) => r.kind === "config").map((r) => r.dir)).toEqual(
			expect.arrayContaining([join(cwd, ".claude", "skills"), join(cwd, ".pi", "agent", "skills")]),
		)
	})

	describe("resolveSkillPathsForDiscovery", () => {
		it("contributes original per-skill directories without per-discovery temp copies", () => {
			const bundledDir = join(home, "bundled")
			const harnessDir = resolveHarnessSkillsDir(home)
			for (const [root, name] of [
				[bundledDir, "unique"],
				[bundledDir, "shadowed"],
				[harnessDir, "shadowed"],
			]) {
				mkdirSync(join(root, name), { recursive: true })
				writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`)
			}

			const options = { homeDir: home, bundledDir, configPaths: [] }
			const first = resolveSkillPathsForDiscovery(cwd, options)
			const second = resolveSkillPathsForDiscovery(cwd, options)
			const expected = [join(bundledDir, "unique")]

			expect(first).toEqual(expected)
			expect(second).toEqual(expected)
			const loaded = first.flatMap((path) => loadSkillsFromDir({ dir: path, source: "path" }).skills)
			expect(loaded.map((skill) => skill.name)).toEqual(["unique"])
			expect(loaded[0]?.filePath).toBe(join(bundledDir, "unique", "SKILL.md"))
		})
	})
})
