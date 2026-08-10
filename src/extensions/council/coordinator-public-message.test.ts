import { describe, expect, it } from "vitest"
import type { ChangeSet } from "../../agent-patch/index.js"
import { describeChangeSet, resolvePublicMessage } from "./public-message.js"

function changeSet(operations: ChangeSet["operations"], files = operations.length): ChangeSet {
	return {
		transactionId: "txn",
		operations,
		base: [],
		patch: "",
		patchSha256: "sha",
		stats: { files, addedLines: 0, removedLines: 0, patchBytes: 0 },
	}
}

describe("describeChangeSet", () => {
	it("describes a single updated file", () => {
		const set = changeSet([{ kind: "update", path: "slugify.js", baseSha256: "a", content: "x" }])
		expect(describeChangeSet(set)).toBe("Updated slugify.js.")
	})

	it("lists a few updated files", () => {
		const set = changeSet([
			{ kind: "update", path: "slugify.js", baseSha256: "a", content: "x" },
			{ kind: "update", path: "index.js", baseSha256: "b", content: "y" },
		])
		expect(describeChangeSet(set)).toBe("Updated slugify.js, index.js.")
	})

	it("falls back to a count for many files", () => {
		const set = changeSet(
			Array.from({ length: 7 }, (_, index) => ({
				kind: "update" as const,
				path: `file-${index}.js`,
				baseSha256: "a",
				content: "x",
			})),
		)
		expect(describeChangeSet(set)).toBe("Updated 7 files.")
	})

	it("reflects mixed operation kinds", () => {
		const set = changeSet([
			{ kind: "create", path: "config.js", content: "x" },
			{ kind: "update", path: "index.js", baseSha256: "a", content: "y" },
		])
		expect(describeChangeSet(set)).toBe("Created config.js and updated index.js.")
	})

	it("reflects deletions and renames alongside creates and updates", () => {
		const set = changeSet([
			{ kind: "create", path: "config.js", content: "x" },
			{ kind: "update", path: "index.js", baseSha256: "a", content: "y" },
			{ kind: "delete", path: "old.js", baseSha256: "b" },
			{ kind: "rename", path: "new-name.js", fromPath: "name.js", baseSha256: "c", content: "z" },
		])
		expect(describeChangeSet(set)).toBe("Created config.js, updated index.js, deleted old.js and renamed new-name.js.")
	})

	it("never throws and always returns a non-empty sentence, even for an empty change set", () => {
		const set = changeSet([], 0)
		expect(describeChangeSet(set)).toBe("Applied the staged change.")
	})
})

describe("resolvePublicMessage", () => {
	const fallbackSet = changeSet([{ kind: "update", path: "file.txt", baseSha256: "a", content: "x" }])

	it("prefers the lead's own prose when present", () => {
		expect(resolvePublicMessage("Lead prose.", "Synthesis summary.", fallbackSet)).toBe("Lead prose.")
	})

	it("falls back to the synthesis summary when the lead has no usable prose", () => {
		expect(resolvePublicMessage(undefined, "Synthesis summary.", fallbackSet)).toBe("Synthesis summary.")
	})

	it("ignores a blank synthesis summary and falls further back to the derived change-set line", () => {
		expect(resolvePublicMessage("", "   ", fallbackSet)).toBe("Updated file.txt.")
	})

	it("derives from the change set when neither lead prose nor a summary is present", () => {
		expect(resolvePublicMessage(undefined, undefined, fallbackSet)).toBe("Updated file.txt.")
	})
})
