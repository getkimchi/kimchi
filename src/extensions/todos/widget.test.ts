import type { Theme } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it } from "vitest"
import { __resetTodoStore, applyWriteTodos } from "./store.js"
import { __test_buildTodoLines, __test_summarizeTodos } from "./widget.js"

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme

describe("todo widget helpers", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("renders empty state", () => {
		expect(__test_buildTodoLines(theme)).toContain("No todos yet. Add one with `/todos add <text>`.")
	})

	it("summarizes and renders mixed statuses", () => {
		applyWriteTodos({
			todos: [
				{ content: "active", status: "in_progress" },
				{ content: "blocked", status: "blocked" },
				{ content: "pending", status: "pending" },
				{ content: "done", status: "completed" },
			],
		})

		expect(__test_summarizeTodos()).toBe("1/4 done · 3 active · 1 blocked")
		expect(__test_buildTodoLines(theme)).toEqual([
			"Todos · Global",
			"",
			"1/4 done · 3 active · 1 blocked",
			"",
			"  1.  ▶ active",
			"  2.  ! blocked",
			"  3.  ○ pending",
			"  4.  ✓ done",
		])
	})
})
