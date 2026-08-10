import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

function readSource(relativePath: string): string {
	return readFileSync(resolve(process.cwd(), relativePath), "utf8")
}

describe("todo system prompt cache contract (source)", () => {
	it("keeps the todos system-prompt block static and reintroducing todo-state impossible by omission", () => {
		const promptBlock = readSource("src/extensions/todos/prompt-block.ts")
		const index = readSource("src/extensions/todos/index.ts")

		expect(promptBlock).toContain('id: "todo-guidance"')
		expect(promptBlock).not.toContain('id: "todo-state"')
		expect(promptBlock).not.toContain("registerTodoStateBlock")

		expect(index).toContain("registerTodoContextState(pi)")
		expect(index).not.toContain("registerTodoStateBlock")
	})

	it("keeps dynamic todo state in the transient context event path only", () => {
		const contextState = readSource("src/extensions/todos/context-state.ts")

		expect(contextState).toContain('pi.on("context"')
		expect(contextState).toContain("customType: TODO_STATE_CUSTOM_TYPE")
		expect(contextState).toContain("renderTodoStateMarkdown")
	})
})
