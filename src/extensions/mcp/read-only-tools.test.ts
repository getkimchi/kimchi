import { describe, expect, it } from "vitest"
import { isReadOnlyMcpToolName } from "./read-only-tools.js"

describe("isReadOnlyMcpToolName", () => {
	it.each([
		"get_issue",
		"search_docs",
		"list_projects",
		"read_file",
		"fetch_url",
	])("classifies %s as read-only", (name) => {
		expect(isReadOnlyMcpToolName(name)).toBe(true)
	})

	it.each([
		"create_issue",
		"update_page",
		"delete_project",
		"reset_database",
	])("does not classify %s as read-only", (name) => {
		expect(isReadOnlyMcpToolName(name)).toBe(false)
	})
})
