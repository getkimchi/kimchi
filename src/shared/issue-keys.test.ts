import { describe, expect, it } from "vitest"
import { branchIssueKeys, isIssueKey, MAX_PULL_REQUEST_ISSUE_KEYS, savedBranchIssueKeys } from "./issue-keys.js"

describe("issue keys in a branch name", () => {
	const project = (length: number) => `A${"B".repeat(length - 1)}`
	const number = (length: number) => "9".repeat(length)

	it.each([
		["finds no key without an issue number (K30)", "main", []],
		["ignores tracker wording without an issue number", "feature/add-issue", []],
		["normalizes a fully lowercase key (K01)", "feat/eng-123-x", ["ENG-123"]],
		["rejects a one-character lowercase project (K04)", "feat/a-123-x", []],
		["rejects a key followed by a letter (K05)", "ENG-123abc", []],
		["rejects a key starting after a letter (K12)", "xENG-123", []],
		["rejects a key starting after a digit", "1ABC-123", []],
		["rejects a key starting after an underscore (K13)", "_ENG-123", []],
		["rejects a key followed by an underscore (K14)", "ENG-123_fix", []],
		["finds an uppercase key followed by a slug (K07)", "feature/ENG-123-add-issue", ["ENG-123"]],
		["finds an uppercase key in its own path segment", "feature/ABC-123", ["ABC-123"]],
		["deduplicates repeated uppercase keys", "ABC-123/ABC-123-follow-up", ["ABC-123"]],
		["deduplicates lowercase and uppercase forms (K24)", "feature/abc-123/ABC-123/abc-123", ["ABC-123"]],
		["finds adjacent keys (K16)", "ABC-1-ABC-2", ["ABC-1", "ABC-2"]],
		["finds keys across path segments (K08)", "release/ABC-12/DEF-3", ["ABC-12", "DEF-3"]],
		["starts a key after a nonnumeric word (K15)", "AB-CD-1", ["CD-1"]],
		["treats non-ASCII characters as separators", "éABC-12é", ["ABC-12"]],
		["treats non-ASCII characters as separators around lowercase keys (K23)", "éeng-12é", ["ENG-12"]],
		["normalizes lowercase projects with underscores and digits (K11)", "my_proj2-10", ["MY_PROJ2-10"]],
		["accepts uppercase projects with underscores and digits", "A_1-9", ["A_1-9"]],
		["rejects a one-character uppercase project", "A-1", []],
		["rejects a zero issue number (K17)", "ABC-0", []],
		["rejects an issue number with a leading zero (K18)", "ABC-012", []],
		["accepts a 16-digit issue number (K19)", `ABC-${number(16)}`, [`ABC-${number(16)}`]],
		["rejects a 17-digit issue number (K20)", `ABC-${number(17)}`, []],
		["accepts a 255-character project (K21)", `${project(255)}-1`, [`${project(255)}-1`]],
		["rejects a 256-character project (K22)", `${project(256)}-1`, []],
		["rejects an initially capitalized mixed-case project (K31)", "Eng-123", []],
		["rejects a trailing uppercase letter in a lowercase project (K32)", "ABc-123", []],
		["rejects uppercase letters inside a lowercase project (K33)", "eNG-123", []],
	])("%s: %s", (_name, input, keys) => {
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
