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
