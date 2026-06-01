import { describe, expect, it } from "vitest"
import { parseSyncArgs, parseTeleportArgs } from "./args.js"

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

	it("rejects --no-shallow (removed in favor of worker-side clone)", () => {
		expect(() => parseTeleportArgs("--no-shallow")).toThrow(/Unknown flag/)
	})

	it("reads --skip-session as a boolean", () => {
		expect(parseTeleportArgs("--skip-session")).toEqual({ skipSession: true })
		expect(parseTeleportArgs("name --skip-session")).toEqual({ name: "name", skipSession: true })
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

describe("parseSyncArgs", () => {
	it("defaults to direction=up when no args are passed", () => {
		expect(parseSyncArgs("")).toEqual({
			direction: "up",
			exclude: [],
			includeIgnored: false,
			delete: false,
			dryRun: false,
		})
	})

	it("reads direction as the first positional", () => {
		expect(parseSyncArgs("up").direction).toBe("up")
		expect(parseSyncArgs("down").direction).toBe("down")
	})

	it("reads path as the second positional", () => {
		expect(parseSyncArgs("up README.md").path).toBe("README.md")
		expect(parseSyncArgs("down src/foo.ts").path).toBe("src/foo.ts")
	})

	it("treats a non-direction first positional as the path (direction defaults to up)", () => {
		const args = parseSyncArgs("README.md")
		expect(args.direction).toBe("up")
		expect(args.path).toBe("README.md")
	})

	it("reads --workspace, --exclude, --include-ignored, --delete, --dry-run", () => {
		expect(parseSyncArgs("down --workspace w-1 --exclude '*.tmp' --include-ignored --delete --dry-run")).toMatchObject({
			direction: "down",
			workspace: "w-1",
			exclude: ["'*.tmp'"],
			includeIgnored: true,
			delete: true,
			dryRun: true,
		})
	})

	it("supports --path as an alternative to the positional", () => {
		const args = parseSyncArgs("up --path src/foo.ts")
		expect(args.path).toBe("src/foo.ts")
	})

	it("rejects --path specified twice", () => {
		expect(() => parseSyncArgs("up src/foo.ts --path src/bar.ts")).toThrow(/more than once/)
	})

	it("rejects unknown flags", () => {
		expect(() => parseSyncArgs("--bogus")).toThrow(/Unknown flag/)
	})

	it("rejects --workspace without a value", () => {
		expect(() => parseSyncArgs("--workspace")).toThrow(/requires a value/)
		expect(() => parseSyncArgs("--workspace --delete")).toThrow(/requires a value/)
	})

	it("rejects --exclude without a value", () => {
		expect(() => parseSyncArgs("--exclude")).toThrow(/requires a glob/)
	})
})
