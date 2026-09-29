import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { digestDbPath } from "./config.js"
import { type ImportBackend, importDbPath, importFacts, parseFactsJsonl, parseImportArgs } from "./import.js"

describe("parseImportArgs", () => {
	it("defaults: personal scope, process cwd, no facts file, filtered import", () => {
		const parsed = parseImportArgs([])
		expect(parsed.factsFile).toBeUndefined()
		expect(parsed.scope).toBe("personal")
		expect(parsed.cwd).toBe(process.cwd())
		expect(parsed.verbatim).toBe(false)
	})

	it("parses --facts, --scope, and --cwd", () => {
		const parsed = parseImportArgs(["--facts", "/tmp/facts.jsonl", "--scope", "project", "--cwd", "/repo"])
		expect(parsed).toEqual({ factsFile: "/tmp/facts.jsonl", scope: "project", cwd: "/repo", verbatim: false })
	})

	it("parses --verbatim", () => {
		expect(parseImportArgs(["--verbatim"]).verbatim).toBe(true)
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

	it("filters non-durable facts and redacts credentials by default (same gates as capture)", async () => {
		const add = vi.fn<ImportBackend["add"]>().mockResolvedValue(undefined)
		const factory = vi.fn(async () => ({ add }) satisfies ImportBackend)

		const added = await importFacts(
			[
				{ fact: "User has a dog named Biscuit" },
				{ fact: "As of the conversation, PR #1255 status: tui-e2e still queued" },
				{ fact: "My gateway key is sk-proj-AbC1234567890XyZ9876543210" },
			],
			{ scope: "personal", cwd: "/tmp" },
			factory,
		)

		expect(added).toBe(2)
		expect(add).toHaveBeenCalledTimes(2)
		expect(add).toHaveBeenNthCalledWith(1, "User has a dog named Biscuit", { userId: "personal", infer: false })
		expect(add).toHaveBeenNthCalledWith(2, "My gateway key is [REDACTED-OPENAI_API_KEY]", {
			userId: "personal",
			infer: false,
		})
	})

	it("--verbatim imports byte-for-byte, skipping the gates (oracle contract)", async () => {
		const add = vi.fn<ImportBackend["add"]>().mockResolvedValue(undefined)
		const factory = vi.fn(async () => ({ add }) satisfies ImportBackend)

		const added = await importFacts(
			[{ fact: "As of the conversation, PR #1255 status: queued" }, { fact: "key sk-proj-AbC1234567890XyZ" }],
			{ scope: "personal", cwd: "/tmp", verbatim: true },
			factory,
		)

		expect(added).toBe(2)
		expect(add).toHaveBeenNthCalledWith(1, "As of the conversation, PR #1255 status: queued", {
			userId: "personal",
			infer: false,
		})
		expect(add).toHaveBeenNthCalledWith(2, "key sk-proj-AbC1234567890XyZ", { userId: "personal", infer: false })
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
