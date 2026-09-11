import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveDefaultTags } from "./tags.js"

let root: string
let home: string
let repo: string
let cwd: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kimchi-tags-resolver-"))
	home = join(root, "home")
	// Nested cwd so tests exercise the ancestor walk up to the repo level.
	repo = join(root, "work", "repo")
	cwd = join(repo, "packages", "app")
	mkdirSync(cwd, { recursive: true })
	vi.stubEnv("KIMCHI_TAGS", "")
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

function writeGlobalConfig(tags: string[]): void {
	const path = join(home, ".config", "kimchi", "tags.json")
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify({ tags }))
}

function writeProjectConfig(tags: string[]): void {
	const path = join(repo, ".kimchi", "tags.json")
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify({ tags }))
}

describe("resolveDefaultTags", () => {
	it("returns no tags when no source exists", () => {
		const { tags, tierByTag } = resolveDefaultTags({ cwd, homeDir: home })
		expect(tags).toEqual([])
		expect(tierByTag.size).toBe(0)
	})

	it("loads global config only", () => {
		writeGlobalConfig(["team:backend", "env:prod"])
		const { tags, tierByTag } = resolveDefaultTags({ cwd, homeDir: home })
		expect(tags).toEqual(["env:prod", "team:backend"])
		expect(tierByTag.get("team:backend")).toBe("global")
	})

	it("loads project config via the ancestor walk from a nested cwd", () => {
		writeProjectConfig(["repo:api"])
		const { tags, tierByTag } = resolveDefaultTags({ cwd, homeDir: home })
		expect(tags).toEqual(["repo:api"])
		expect(tierByTag.get("repo:api")).toBe("project")
	})

	it("unions global and project tags without collisions", () => {
		writeGlobalConfig(["team:backend"])
		writeProjectConfig(["repo:api"])
		const { tags } = resolveDefaultTags({ cwd, homeDir: home })
		expect(tags).toEqual(["repo:api", "team:backend"])
	})

	it("project beats global on key collision", () => {
		writeGlobalConfig(["team:backend", "env:prod"])
		writeProjectConfig(["team:frontend"])
		const { tags, tierByTag } = resolveDefaultTags({ cwd, homeDir: home })
		expect(tags).toEqual(["env:prod", "team:frontend"])
		expect(tierByTag.get("team:frontend")).toBe("project")
		expect(tierByTag.has("team:backend")).toBe(false)
	})

	it("env beats project and global on key collision", () => {
		writeGlobalConfig(["team:backend"])
		writeProjectConfig(["team:frontend", "repo:api"])
		const { tags, tierByTag } = resolveDefaultTags({ cwd, homeDir: home, envTags: "team:override,envtag:1" })
		expect(tags).toEqual(["envtag:1", "repo:api", "team:override"])
		expect(tierByTag.get("team:override")).toBe("env")
		expect(tierByTag.get("repo:api")).toBe("project")
	})

	it("same-key tags within one tier coexist", () => {
		writeGlobalConfig(["team:a", "team:b"])
		const { tags } = resolveDefaultTags({ cwd, homeDir: home })
		expect(tags).toEqual(["team:a", "team:b"])
	})

	it("a stronger tier replaces all weaker tags sharing its key", () => {
		writeGlobalConfig(["team:a", "team:b"])
		writeProjectConfig(["team:c"])
		const { tags, tierByTag } = resolveDefaultTags({ cwd, homeDir: home })
		expect(tags).toEqual(["team:c"])
		expect(tierByTag.get("team:c")).toBe("project")
	})

	it("env replaces all same-key tags from both weaker tiers", () => {
		writeGlobalConfig(["k:global", "other:1"])
		writeProjectConfig(["k:project", "another:2"])
		const { tags, tierByTag } = resolveDefaultTags({ cwd, homeDir: home, envTags: "k:env" })
		expect(tags).toEqual(["another:2", "k:env", "other:1"])
		expect(tierByTag.get("k:env")).toBe("env")
		expect(tierByTag.has("k:global")).toBe(false)
		expect(tierByTag.has("k:project")).toBe(false)
	})

	it("filters invalid tags from files and env", () => {
		writeGlobalConfig(["valid:one", "invalid", ":bad", "key:"])
		const { tags } = resolveDefaultTags({ cwd, homeDir: home, envTags: "env:prod,also invalid,key:" })
		expect(tags).toEqual(["env:prod", "valid:one"])
	})

	it("trims whitespace around env tags", () => {
		const { tags } = resolveDefaultTags({ cwd, homeDir: home, envTags: " a:1 , b:2 " })
		expect(tags).toEqual(["a:1", "b:2"])
	})

	it("treats a corrupt config file as absent and warns with its path", () => {
		const globalPath = join(home, ".config", "kimchi", "tags.json")
		mkdirSync(dirname(globalPath), { recursive: true })
		writeFileSync(globalPath, "{not valid json")
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		writeProjectConfig(["repo:api"])

		const { tags } = resolveDefaultTags({ cwd, homeDir: home })

		expect(tags).toEqual(["repo:api"])
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(globalPath))
	})

	it("falls back to the other tiers when the working directory is unusable", () => {
		writeGlobalConfig(["team:backend"])
		const doomed = join(root, "doomed")
		mkdirSync(doomed)
		const originalCwd = process.cwd()
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		process.chdir(doomed)
		rmSync(doomed, { recursive: true, force: true })
		try {
			const { tags } = resolveDefaultTags({ homeDir: home })
			expect(tags).toEqual(["team:backend"])
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("project tag config discovery failed"))
		} finally {
			process.chdir(originalCwd)
			warn.mockRestore()
		}
	})

	it("ignores a non-array tags field", () => {
		writeGlobalConfig(["ignored:by-non-array-check"])
		const globalPath = join(home, ".config", "kimchi", "tags.json")
		writeFileSync(globalPath, JSON.stringify({ tags: "not-an-array" }))

		const { tags } = resolveDefaultTags({ cwd, homeDir: home })
		expect(tags).toEqual([])
	})

	it("returns sorted output for determinism", () => {
		writeGlobalConfig(["zeta:1", "alpha:1"])
		writeProjectConfig(["mid:1"])
		const { tags } = resolveDefaultTags({ cwd, homeDir: home })
		expect(tags).toEqual(["alpha:1", "mid:1", "zeta:1"])
	})
})
