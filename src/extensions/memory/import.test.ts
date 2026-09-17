import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { digestDbPath } from "./config.js"
import {
	importDbPath,
	importFacts,
	parseFactsJsonl,
	parseImportArgs,
	type ImportBackend,
} from "./import.js"

describe("parseImportArgs", () => {
	it("defaults: personal scope, process cwd, no facts file", () => {
		const parsed = parseImportArgs([])
		expect(parsed.factsFile).toBeUndefined()
		expect(parsed.scope).toBe("personal")
		expect(parsed.cwd).toBe(process.cwd())
	})

	it("parses --facts, --scope, and --cwd", () => {
		const parsed = parseImportArgs(["--facts", "/tmp/facts.jsonl", "--scope", "project", "--cwd", "/repo"])
		expect(parsed).toEqual({ factsFile: "/tmp/facts.jsonl", scope: "project", cwd: "/repo" })
	})

	it("rejects an invalid scope value", () => {
		expect(() => parseImportArgs(["--scope", "team"])).toThrow(/personal.*project/)
	})

	it("rejects unknown arguments", () => {
		expect(() => parseImportArgs(["--facts", "f.jsonl", "--nope"])).toThrow(/unknown argument/)
	})
})

describe("parseFactsJsonl", () => {
	it("parses one fact per line and skips blanks", () => {
		const facts = parseFactsJsonl('{"fact": "User has a dog named Biscuit"}\n\n{"fact": "User lost 10 lbs"}\n')
		expect(facts).toEqual([{ fact: "User has a dog named Biscuit" }, { fact: "User lost 10 lbs" }])
	})

	it("ignores extra fields on records", () => {
		const facts = parseFactsJsonl('{"fact": "a fact", "type": "possession", "source": "oracle"}')
		expect(facts).toEqual([{ fact: "a fact" }])
	})

	it("throws with the line number on invalid JSON", () => {
		expect(() => parseFactsJsonl('{"fact": "ok"}\nnot json\n')).toThrow("line 2: invalid JSON")
	})

	it("throws on a missing, empty, or non-string fact field", () => {
		expect(() => parseFactsJsonl('{"note": "no fact field"}')).toThrow("line 1")
		expect(() => parseFactsJsonl('{"fact": "  "}')).toThrow("line 1")
		expect(() => parseFactsJsonl('{"fact": 42}')).toThrow("line 1")
		expect(() => parseFactsJsonl('"just a string"')).toThrow("line 1")
	})

	it("returns empty for an empty file (caller decides)", () => {
		expect(parseFactsJsonl("\n\n")).toEqual([])
	})
})

describe("importDbPath", () => {
	it("personal scope maps to the same digest path capture uses", () => {
		expect(importDbPath({ scope: "personal", cwd: "/anywhere" })).toBe(digestDbPath())
	})

	it("project scope outside a git repository throws", () => {
		const home = mkdtempSync(join(tmpdir(), "kimchi-import-nogit-"))
		try {
			expect(() => importDbPath({ scope: "project", cwd: home })).toThrow(/git repository/)
		} finally {
			rmSync(home, { recursive: true, force: true })
		}
	})
})

describe("importFacts", () => {
	it("adds each fact verbatim with infer disabled, once per fact", async () => {
		const add = vi.fn<ImportBackend["add"]>().mockResolvedValue(undefined)
		const factory = vi.fn(async () => ({ add }) satisfies ImportBackend)

		const added = await importFacts(
			[{ fact: "User has a dog named Biscuit" }, { fact: "User lost 10 lbs" }],
			{ scope: "personal", cwd: "/tmp" },
			factory,
		)

		expect(added).toBe(2)
		expect(add).toHaveBeenCalledTimes(2)
		expect(add).toHaveBeenNthCalledWith(1, "User has a dog named Biscuit", { userId: "personal", infer: false })
		expect(add).toHaveBeenNthCalledWith(2, "User lost 10 lbs", { userId: "personal", infer: false })
	})

	it("imports zero facts without touching the backend", async () => {
		const add = vi.fn<ImportBackend["add"]>()
		const factory = vi.fn(async () => ({ add }) satisfies ImportBackend)

		const added = await importFacts([], { scope: "personal", cwd: "/tmp" }, factory)

		expect(added).toBe(0)
		expect(factory).toHaveBeenCalledTimes(1)
		expect(add).not.toHaveBeenCalled()
	})
})
