import { describe, expect, it } from "vitest"
import {
	TeleportArgsError,
	parseAttachArgs,
	parseConnectArgs,
	parseDetachArgs,
	parseSyncArgs,
	parseTeleportArgs,
} from "./args.js"

describe("parseTeleportArgs", () => {
	it("returns defaults for empty input", () => {
		expect(parseTeleportArgs("")).toEqual({
			allowDirty: false,
			exclude: [],
			includeIgnored: false,
			abandonPending: false,
			force: false,
			skipSession: false,
			noGitToken: false,
		})
	})

	it("parses a positional name", () => {
		const r = parseTeleportArgs("feature-x")
		expect(r.name).toBe("feature-x")
	})

	it("parses every boolean flag", () => {
		const r = parseTeleportArgs(
			"--allow-dirty --include-ignored --abandon-pending --force --skip-session --no-git-token",
		)
		expect(r.allowDirty).toBe(true)
		expect(r.includeIgnored).toBe(true)
		expect(r.abandonPending).toBe(true)
		expect(r.force).toBe(true)
		expect(r.skipSession).toBe(true)
		expect(r.noGitToken).toBe(true)
	})

	it("collects repeated --exclude globs in order", () => {
		const r = parseTeleportArgs("--exclude foo --exclude bar/**")
		expect(r.exclude).toEqual(["foo", "bar/**"])
	})

	it("handles mixed order of name and flags", () => {
		const r = parseTeleportArgs("--allow-dirty my-name --exclude tmp")
		expect(r.name).toBe("my-name")
		expect(r.allowDirty).toBe(true)
		expect(r.exclude).toEqual(["tmp"])
	})

	it("throws on a second positional argument", () => {
		expect(() => parseTeleportArgs("first second")).toThrow(TeleportArgsError)
	})

	it("throws when --exclude has no argument", () => {
		expect(() => parseTeleportArgs("--exclude")).toThrow(/--exclude/)
	})

	it("throws when --exclude is followed by another flag", () => {
		expect(() => parseTeleportArgs("--exclude --force")).toThrow(/--exclude/)
	})

	it("throws on an unknown flag", () => {
		expect(() => parseTeleportArgs("--what")).toThrow(/Unknown flag/)
	})
})

describe("parseDetachArgs", () => {
	it("returns defaults for empty input", () => {
		expect(parseDetachArgs("")).toEqual({ abandonPending: false })
	})

	it("parses --abandon-pending", () => {
		expect(parseDetachArgs("--abandon-pending")).toEqual({ abandonPending: true })
	})

	it("throws on unknown argument", () => {
		expect(() => parseDetachArgs("foo")).toThrow(TeleportArgsError)
	})
})

describe("parseAttachArgs", () => {
	it("parses a single positional target", () => {
		expect(parseAttachArgs("my-feature")).toEqual({ target: "my-feature" })
	})

	it("throws on empty input", () => {
		expect(() => parseAttachArgs("")).toThrow(/Usage:/)
	})

	it("throws when given multiple arguments", () => {
		expect(() => parseAttachArgs("a b")).toThrow(/single name or id/)
	})

	it("throws when given a flag instead of a target", () => {
		expect(() => parseAttachArgs("--whatever")).toThrow(/flag/)
	})
})

describe("parseConnectArgs", () => {
	it("returns empty object on empty input", () => {
		expect(parseConnectArgs("")).toEqual({})
	})

	it("parses a single positional target", () => {
		expect(parseConnectArgs("alpha")).toEqual({ target: "alpha" })
	})

	it("throws on multiple arguments", () => {
		expect(() => parseConnectArgs("a b")).toThrow(TeleportArgsError)
	})

	it("throws when given a flag", () => {
		expect(() => parseConnectArgs("--whatever")).toThrow(/flag/)
	})
})

describe("parseSyncArgs", () => {
	it("returns defaults for empty input (direction defaults to up)", () => {
		expect(parseSyncArgs("")).toEqual({
			direction: "up",
			exclude: [],
			includeIgnored: false,
			delete: false,
			dryRun: false,
		})
	})

	it("parses 'up' direction", () => {
		const r = parseSyncArgs("up")
		expect(r.direction).toBe("up")
	})

	it("parses 'down' direction", () => {
		const r = parseSyncArgs("down")
		expect(r.direction).toBe("down")
	})

	it("parses direction with a positional path", () => {
		const r = parseSyncArgs("down src/foo")
		expect(r.direction).toBe("down")
		expect(r.path).toBe("src/foo")
	})

	it("parses --path flag", () => {
		const r = parseSyncArgs("up --path src/bar")
		expect(r.path).toBe("src/bar")
	})

	it("parses --delete flag", () => {
		const r = parseSyncArgs("up --delete")
		expect(r.delete).toBe(true)
	})

	it("parses --no-delete flag (overrides --delete)", () => {
		const r = parseSyncArgs("up --delete --no-delete")
		expect(r.delete).toBe(false)
	})

	it("parses --dry-run flag", () => {
		const r = parseSyncArgs("down --dry-run")
		expect(r.dryRun).toBe(true)
	})

	it("parses --include-ignored flag", () => {
		const r = parseSyncArgs("up --include-ignored")
		expect(r.includeIgnored).toBe(true)
	})

	it("collects repeated --exclude globs", () => {
		const r = parseSyncArgs("up --exclude *.log --exclude tmp/")
		expect(r.exclude).toEqual(["*.log", "tmp/"])
	})

	it("handles all flags combined", () => {
		const r = parseSyncArgs("down --delete --dry-run --include-ignored --exclude node_modules --path lib")
		expect(r.direction).toBe("down")
		expect(r.delete).toBe(true)
		expect(r.dryRun).toBe(true)
		expect(r.includeIgnored).toBe(true)
		expect(r.exclude).toEqual(["node_modules"])
		expect(r.path).toBe("lib")
	})

	it("throws when direction is specified twice", () => {
		expect(() => parseSyncArgs("up down")).toThrow(/Direction already set/)
	})

	it("throws on unknown flag", () => {
		expect(() => parseSyncArgs("up --bogus")).toThrow(/Unknown flag/)
	})

	it("throws when --exclude has no argument", () => {
		expect(() => parseSyncArgs("up --exclude")).toThrow(/--exclude/)
	})

	it("throws when --exclude is followed by another flag", () => {
		expect(() => parseSyncArgs("up --exclude --delete")).toThrow(/--exclude/)
	})

	it("throws when --path has no argument", () => {
		expect(() => parseSyncArgs("up --path")).toThrow(/--path/)
	})

	it("throws when --path is specified twice", () => {
		expect(() => parseSyncArgs("up --path a --path b")).toThrow(/--path/)
	})

	it("throws on positional before direction keyword", () => {
		expect(() => parseSyncArgs("somefile")).toThrow(/Expected "up" or "down"/)
	})

	it("throws on second positional path", () => {
		expect(() => parseSyncArgs("up first second")).toThrow(/Unexpected positional/)
	})
})
