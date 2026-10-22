import { describe, expect, it } from "vitest"
import { branchIssueKeys, isIssueKey, MAX_PULL_REQUEST_ISSUE_KEYS, savedBranchIssueKeys } from "./issue-keys.js"

describe("Jira keys in a branch name", () => {
	it.each([
		["main", []],
		["feature/add-jira", []],
		// Jira keys are uppercase; a lowercase or mixed-case token is not one.
		["abc-123-add-jira", []],
		["ABc-123", []],
		// A key that runs into a letter, digit or underscore is part of a longer word.
		["xABC-123", []],
		["ABC-123x", []],
		["ABC-123_fix", []],
		["_ABC-123", []],
		["ABC-123-add-jira", ["ABC-123"]],
		["feature/ABC-123", ["ABC-123"]],
		["ABC-123/ABC-123-follow-up", ["ABC-123"]],
		["ABC-1-ABC-2", ["ABC-1", "ABC-2"]],
		["release/ABC-12/DEF-3", ["ABC-12", "DEF-3"]],
		// A word that is not a key's number can still start the next key.
		["AB-CD-1", ["CD-1"]],
		// A non-ASCII character ends a word, as any separator does.
		["éABC-12é", ["ABC-12"]],
		["A_1-9", ["A_1-9"]],
		["A-1", []],
		["ABC-0", []],
		["ABC-012", []],
		[`ABC-${"9".repeat(16)}`, [`ABC-${"9".repeat(16)}`]],
		[`ABC-${"9".repeat(17)}`, []],
		[`A${"B".repeat(254)}-1`, [`A${"B".repeat(254)}-1`]],
		[`A${"B".repeat(255)}-1`, []],
	])("finds the keys in %s", (branch, keys) => {
		expect(branchIssueKeys(branch)).toEqual(keys)
	})
})

describe("a Jira issue key", () => {
	it.each(["AB-1", "ABC-123", "A_1-9", `A${"B".repeat(254)}-1`, `ABC-${"9".repeat(16)}`])("accepts %s", (key) => {
		expect(isIssueKey(key)).toBe(true)
	})
	it.each([
		"",
		"ABC",
		"A-1",
		"abc-1",
		"1BC-1",
		"_BC-1",
		"ABC-0",
		"ABC-01",
		"ABC-1-2",
		"ABC-1 ",
		" ABC-1",
		"ABC-",
		"-1",
		`A${"B".repeat(255)}-1`,
		`ABC-${"9".repeat(17)}`,
		"ABÇ-1",
	])("refuses %j", (text) => {
		expect(isIssueKey(text)).toBe(false)
	})
})

describe("saved branch keys", () => {
	it.each([
		["valid keys", ["ABC-1", "DEF-2"], ["ABC-1", "DEF-2"]],
		["no keys", [], []],
		["a missing list", undefined, []],
		["a list with a malformed key", ["ABC-1", "abc-2"], []],
		["a list with a non-text key", ["ABC-1", 2], []],
		["too many keys", Array.from({ length: MAX_PULL_REQUEST_ISSUE_KEYS + 1 }, (_, i) => `ABC-${i + 1}`), []],
	])("reads %s", (_case, saved, keys) => {
		expect(savedBranchIssueKeys(saved)).toEqual(keys)
	})
})
