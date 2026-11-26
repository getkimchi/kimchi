import { describe, expect, it } from "vitest"
import { branchIssueKeys, isIssueKey, MAX_PULL_REQUEST_ISSUE_KEYS, savedBranchIssueKeys } from "./issue-keys.js"

describe("issue keys in a branch name", () => {
	it.each([
		["main", []],
		["feature/add-jira", []],
		// A key that runs into a letter, digit or underscore is part of a longer word.
		["1ABC-123", []],
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

describe("branch-source conformance rows", () => {
	const project = (length: number) => `A${"B".repeat(length - 1)}`
	const number = (length: number) => "9".repeat(length)
	const branchCases: [id: string, input: string, keys: string[]][] = [
		["K01", "feat/eng-123-x", ["ENG-123"]],
		["K04", "feat/a-123-x", []],
		["K05", "ENG-123abc", []],
		["K07", "feature/ENG-123-add-jira", ["ENG-123"]],
		["K08", "release/ABC-12/DEF-3", ["ABC-12", "DEF-3"]],
		["K11", "my_proj2-10", ["MY_PROJ2-10"]],
		["K12", "xENG-123", []],
		["K13", "_ENG-123", []],
		["K14", "ENG-123_fix", []],
		["K15", "AB-CD-1", ["CD-1"]],
		["K16", "ABC-1-ABC-2", ["ABC-1", "ABC-2"]],
		["K17", "ABC-0", []],
		["K18", "ABC-012", []],
		["K19", `ABC-${number(16)}`, [`ABC-${number(16)}`]],
		["K20", `ABC-${number(17)}`, []],
		["K21", `${project(255)}-1`, [`${project(255)}-1`]],
		["K22", `${project(256)}-1`, []],
		["K23", "éeng-12é", ["ENG-12"]],
		["K24", "feature/abc-123/ABC-123/abc-123", ["ABC-123"]],
		["K30", "main", []],
		["K31", "Eng-123", []],
		["K32", "ABc-123", []],
		["K33", "eNG-123", []],
	]

	it.each(branchCases)("%s: %s", (_id, input, keys) => {
		expect(branchIssueKeys(input)).toEqual(keys)
	})
})

describe("non-branch conformance rows without a local extraction path", () => {
	const twentyFiveKeys = Array.from({ length: 25 }, (_, index) => `ABC-${index + 1}`).join(" ")
	// Kimchi carries these texts as metadata and does not derive issue keys from either source locally.
	const unavailableRows = [
		["K02", "title", "eng-123", "none"],
		["K03", "work title", "eng-123", "none"],
		["K06", "title", "ENG-123abc", "none"],
		["K09", "title", "ENG-123: fix login", "ENG-123"],
		["K10", "work title", "ENG-123: fix login", "ENG-123"],
		["K26", "title", twentyFiveKeys, "ABC-1 through ABC-20"],
		["K27", "work title", twentyFiveKeys, "ABC-1 through ABC-20"],
		["K28", "title", "WID-1 then WID-1, WID-2 and WID-3", "WID-1, WID-2, WID-3"],
		["K29", "work title", "WID-2 WID-1 WID-2 WID-1", "WID-2, WID-1"],
	]

	for (const [id, source, input, expected] of unavailableRows) {
		it.todo(`${id}: ${source} ${JSON.stringify(input)} -> ${expected}; this source has no local parser`)
	}
})

describe("a canonical issue key", () => {
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
