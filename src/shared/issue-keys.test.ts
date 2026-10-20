import { describe, expect, it } from "vitest"
import { branchIssueKeys } from "./issue-keys.js"

describe("Jira keys in a branch name", () => {
	it.each([
		["main", []],
		["feature/add-jira", []],
		// Jira keys are uppercase; a lowercase or mixed-case token is not one.
		["abc-123-add-jira", []],
		// A key that runs into a letter, digit or underscore is part of a longer word.
		["xABC-123", []],
		["ABC-123x", []],
		["ABC-123_fix", []],
		["ABC-123-add-jira", ["ABC-123"]],
		["feature/ABC-123", ["ABC-123"]],
		["ABC-123/ABC-123-follow-up", ["ABC-123"]],
		["ABC-1-ABC-2", ["ABC-1", "ABC-2"]],
		["release/ABC-12/DEF-3", ["ABC-12", "DEF-3"]],
	])("finds the keys in %s", (branch, keys) => {
		expect(branchIssueKeys(branch)).toEqual(keys)
	})
})
