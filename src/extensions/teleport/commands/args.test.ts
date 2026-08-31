import { describe, expect, it } from "vitest"
import { getTeleportArgumentCompletions, parseSyncArgs, parseTeleportArgs } from "./args.js"

describe("parseTeleportArgs", () => {
	it("returns empty when no args are passed", () => {
		expect(parseTeleportArgs("")).toEqual({})
		expect(parseTeleportArgs("   ")).toEqual({})
	})

	it("reads a positional session name", () => {
		expect(parseTeleportArgs("mysession")).toEqual({ name: "mysession" })
	})

	it("reads --workspace ID with space separator", () => {
		expect(parseTeleportArgs("--workspace w-123")).toEqual({ workspace: "w-123" })
	})

	it("reads --workspace=ID with equals separator", () => {
		expect(parseTeleportArgs("--workspace=w-123")).toEqual({ workspace: "w-123" })
	})

	it("reads name and --workspace together (any order)", () => {
		expect(parseTeleportArgs("mysession --workspace w-1")).toEqual({ name: "mysession", workspace: "w-1" })
		expect(parseTeleportArgs("--workspace w-1 mysession")).toEqual({ name: "mysession", workspace: "w-1" })
	})

	it("rejects an invalid session name", () => {
		expect(() => parseTeleportArgs("bad name")).toThrow(/Unexpected positional/)
		expect(() => parseTeleportArgs("bad/slash")).toThrow(/Invalid session name/)
		expect(() => parseTeleportArgs("bad$dollar")).toThrow(/Invalid session name/)
	})

	it("reads --allow-dirty and --force as booleans", () => {
		expect(parseTeleportArgs("--allow-dirty --force")).toEqual({ allowDirty: true, force: true })
		expect(parseTeleportArgs("--allow-dirty")).toEqual({ allowDirty: true })
		expect(parseTeleportArgs("--force")).toEqual({ force: true })
	})

	it("reads --git-repo and --branch", () => {
		expect(parseTeleportArgs("name --git-repo https://x/y.git --branch main")).toEqual({
			name: "name",
			gitRepo: "https://x/y.git",
			branch: "main",
		})
	})

	it("reads --no-git-token as a boolean", () => {
		expect(parseTeleportArgs("--no-git-token")).toEqual({ noGitToken: true })
	})

	it("reads --no-compact-hint as a boolean", () => {
		expect(parseTeleportArgs("--no-compact-hint")).toEqual({ noCompactHint: true })
	})

	it("rejects --no-shallow (removed in favor of worker-side clone)", () => {
		expect(() => parseTeleportArgs("--no-shallow")).toThrow(/Unknown flag/)
	})

	it("reads --skip-session as a boolean", () => {
		expect(parseTeleportArgs("--skip-session")).toEqual({ skipSession: true })
		expect(parseTeleportArgs("name --skip-session")).toEqual({ name: "name", skipSession: true })
	})

	it("reads --fast as a boolean", () => {
		expect(parseTeleportArgs("--fast")).toEqual({ fast: true })
	})

	it("reads --git-repo with --fast together", () => {
		expect(parseTeleportArgs("--git-repo https://x/y.git --fast")).toEqual({
			gitRepo: "https://x/y.git",
			fast: true,
		})
	})

	it("leaves fast unset by default", () => {
		expect(parseTeleportArgs("").fast).toBeUndefined()
		expect(parseTeleportArgs("name --force").fast).toBeUndefined()
	})

	it("rejects unknown flags", () => {
		expect(() => parseTeleportArgs("--bogus")).toThrow(/Unknown flag/)
	})

	it("rejects --workspace without a value", () => {
		expect(() => parseTeleportArgs("--workspace")).toThrow(/requires a value/)
		expect(() => parseTeleportArgs("--workspace --force")).toThrow(/requires a value/)
		expect(() => parseTeleportArgs("--workspace=")).toThrow(/non-empty/)
	})

	it("rejects a stray --", () => {
		expect(() => parseTeleportArgs("name --")).toThrow(/Unexpected `--`/)
	})
})

describe("getTeleportArgumentCompletions", () => {
	it("returns all flags for a non-dash, non-empty prefix (discoverable while typing a name)", () => {
		const result = getTeleportArgumentCompletions("my-session")
		expect(result).not.toBeNull()
		expect(result).toHaveLength(9)
		const labels = result?.map((c) => c.label)
		expect(labels).toContain("--workspace")
		expect(labels).toContain("--git-repo")
		expect(labels).toContain("--skip-session")
	})

	it("returns all flags for a non-dash partial like 'task-1'", () => {
		const result = getTeleportArgumentCompletions("task-1")
		expect(result).not.toBeNull()
		expect(result).toHaveLength(9)
	})

	it("returns discovery items on an empty prefix", () => {
		const result = getTeleportArgumentCompletions("")
		expect(result).not.toBeNull()
		expect(result).toHaveLength(3)
		const labels = result?.map((c) => c.label)
		expect(labels).toEqual(["my-feature", "--allow-dirty", "--force"])
	})

	it("returns discovery items on a whitespace-only prefix", () => {
		const result = getTeleportArgumentCompletions("   ")
		expect(result).not.toBeNull()
		expect(result).toHaveLength(3)
		const labels = result?.map((c) => c.label)
		expect(labels).toEqual(["my-feature", "--allow-dirty", "--force"])
	})

	it("returns all flags when prefix is just --", () => {
		const result = getTeleportArgumentCompletions("--")
		expect(result).not.toBeNull()
		expect(result).toHaveLength(9)
		const labels = result?.map((c) => c.label)
		expect(labels).toContain("--allow-dirty")
		expect(labels).toContain("--force")
		expect(labels).toContain("--workspace")
		expect(labels).toContain("--git-repo")
		expect(labels).toContain("--branch")
		expect(labels).toContain("--no-git-token")
		expect(labels).toContain("--no-compact-hint")
		expect(labels).toContain("--skip-session")
		expect(labels).toContain("--fast")
	})

	it("filters by --all to --allow-dirty", () => {
		const result = getTeleportArgumentCompletions("--all")
		expect(result).toEqual([
			{ value: "--allow-dirty", label: "--allow-dirty", description: "Proceed with uncommitted changes" },
		])
	})

	it("filters by --force to exactly --force", () => {
		const result = getTeleportArgumentCompletions("--force")
		expect(result).toEqual([
			{ value: "--force", label: "--force", description: "Override the 5 GB workspace size limit" },
		])
	})

	it("filters by --fast to exactly --fast", () => {
		const result = getTeleportArgumentCompletions("--fast")
		expect(result).toEqual([
			{
				value: "--fast",
				label: "--fast",
				description: "Clone server-side + rsync only local diff (faster for large repos)",
			},
		])
	})

	it("filters by --no to both --no-* flags", () => {
		const result = getTeleportArgumentCompletions("--no")
		expect(result).not.toBeNull()
		const labels = result?.map((c) => c.label)
		expect(labels).toContain("--no-git-token")
		expect(labels).toContain("--no-compact-hint")
	})

	it("returns null when no flag matches", () => {
		expect(getTeleportArgumentCompletions("--xyz")).toBeNull()
		expect(getTeleportArgumentCompletions("--zzzz")).toBeNull()
	})

	it("is case-insensitive", () => {
		const result = getTeleportArgumentCompletions("--FORCE")
		expect(result).toEqual([
			{ value: "--force", label: "--force", description: "Override the 5 GB workspace size limit" },
		])
	})

	it("emits a trailing space for value flags", () => {
		const result = getTeleportArgumentCompletions("--workspace")
		expect(result).toEqual([
			{ value: "--workspace ", label: "--workspace", description: "Reuse an existing workspace (id or name)" },
		])
	})

	it("emits a trailing space for --git-repo", () => {
		const result = getTeleportArgumentCompletions("--git-repo")
		expect(result).toEqual([
			{
				value: "--git-repo ",
				label: "--git-repo",
				description: "Clone from a git URL instead of rsyncing local files",
			},
		])
	})

	it("emits a trailing space for --branch", () => {
		const result = getTeleportArgumentCompletions("--branch")
		expect(result).toEqual([
			{ value: "--branch ", label: "--branch", description: "Branch to check out (requires --git-repo)" },
		])
	})

	it("does not emit a trailing space for boolean flags", () => {
		const result = getTeleportArgumentCompletions("--skip-session")
		expect(result).toEqual([
			{
				value: "--skip-session",
				label: "--skip-session",
				description: "Start remote agent fresh without uploading session history",
			},
		])
	})
})

describe("parseSyncArgs", () => {
	const required = "--workspace w-1 --source ./src --target /home/sandbox/project/src"

	it("parses a full up command with all required flags", () => {
		expect(parseSyncArgs(`up ${required}`)).toEqual({
			direction: "up",
			workspace: "w-1",
			source: "./src",
			target: "/home/sandbox/project/src",
			exclude: [],
			includeIgnored: false,
			delete: false,
			dryRun: false,
		})
	})

	it("parses a full down command (source is remote, target is local)", () => {
		expect(parseSyncArgs("down --workspace w-1 --source ~/project/dist/ --target ./dist/")).toMatchObject({
			direction: "down",
			workspace: "w-1",
			source: "~/project/dist/",
			target: "./dist/",
		})
	})

	it("reads --exclude (repeatable), --include-ignored, --delete, --dry-run", () => {
		expect(
			parseSyncArgs(`down ${required} --exclude '*.tmp' --exclude logs/ --include-ignored --delete --dry-run`),
		).toMatchObject({
			direction: "down",
			exclude: ["'*.tmp'", "logs/"],
			includeIgnored: true,
			delete: true,
			dryRun: true,
		})
	})

	it("--no-delete overrides a preceding --delete", () => {
		expect(parseSyncArgs(`up ${required} --delete --no-delete`).delete).toBe(false)
	})

	it("accepts flags in any order", () => {
		const args = parseSyncArgs("--source ./a --workspace w-1 --target /b up")
		expect(args).toMatchObject({ direction: "up", workspace: "w-1", source: "./a", target: "/b" })
	})

	it("supports --flag=value form", () => {
		expect(parseSyncArgs("up --workspace=w-1 --source=./a --target=/b")).toMatchObject({
			workspace: "w-1",
			source: "./a",
			target: "/b",
		})
	})

	it("rejects missing direction", () => {
		expect(() => parseSyncArgs(required)).toThrow(/Missing direction/)
	})

	it("rejects an invalid direction", () => {
		expect(() => parseSyncArgs(`sideways ${required}`)).toThrow(/Direction must be "up" or "down"/)
	})

	it("rejects extra positional arguments", () => {
		expect(() => parseSyncArgs(`up down ${required}`)).toThrow(/Unexpected positional/)
		expect(() => parseSyncArgs(`up README.md ${required}`)).toThrow(/Unexpected positional/)
	})

	it("rejects missing --workspace / --source / --target", () => {
		expect(() => parseSyncArgs("up --source ./a --target /b")).toThrow(/--workspace/)
		expect(() => parseSyncArgs("up --workspace w --target /b")).toThrow(/--source/)
		expect(() => parseSyncArgs("up --workspace w --source ./a")).toThrow(/--target/)
		expect(() => parseSyncArgs("up")).toThrow(/--workspace.*--source.*--target/)
	})

	it("rejects the removed --path flag", () => {
		expect(() => parseSyncArgs(`up ${required} --path src/foo.ts`)).toThrow(/Unknown flag/)
	})

	it("rejects unknown flags", () => {
		expect(() => parseSyncArgs(`up ${required} --bogus`)).toThrow(/Unknown flag/)
	})

	it("rejects --workspace / --source / --target without a value", () => {
		expect(() => parseSyncArgs("up --workspace")).toThrow(/--workspace requires a value/)
		expect(() => parseSyncArgs("up --source --target /b --workspace w")).toThrow(/--source requires a value/)
		expect(() => parseSyncArgs("up --workspace=")).toThrow(/non-empty/)
	})

	it("rejects --exclude without a value", () => {
		expect(() => parseSyncArgs(`up ${required} --exclude`)).toThrow(/requires a glob/)
	})
})
