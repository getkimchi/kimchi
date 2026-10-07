import type { UserMessage } from "@earendil-works/pi-ai"
import type { CustomEntry, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import rewindExtension from "./index.js"

function userPrompt(id: string, content: UserMessage["content"]): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-26T10:00:00.000Z",
		message: { role: "user", content, timestamp: 0 },
	}
}

const marker: CustomEntry = {
	type: "custom",
	id: "todo-1",
	parentId: null,
	timestamp: "2026-09-26T10:00:01.000Z",
	customType: "todos",
}

function setup(
	branch: SessionEntry[],
	options: { idle?: boolean; choose?: (options: string[]) => string | undefined } = {},
) {
	const pi = createExtensionApi()
	rewindExtension(pi.api)
	const select = vi.fn(async (_title: string, choices: string[]) => options.choose?.(choices))
	const ctx = createCommandContext({
		isIdle: vi.fn(() => options.idle ?? true),
		sessionManager: { getBranch: () => branch },
		ui: { select },
	})
	const run = () => pi.getRegisteredCommand("rewind").handler("", ctx)
	return { pi, ctx, select, run }
}

describe("rewind extension", () => {
	it("registers file checkpoints on turns and restore choices for /tree and /fork", () => {
		const { pi } = setup([])
		for (const event of ["turn_start", "turn_end", "session_before_tree", "session_before_fork", "session_shutdown"]) {
			expect(pi.getHandlers(event), event).not.toHaveLength(0)
		}
	})

	it("lists earlier prompts newest first and rewinds to the chosen one without a summary", async () => {
		const branch = [
			userPrompt("u1", "Add a cart module"),
			marker,
			userPrompt("u2", [
				{ type: "text", text: "Fix the failing test\nand add more details" },
				{ type: "image", data: "", mimeType: "image/png" },
			]),
		]
		const { ctx, select, run } = setup(branch, { choose: (choices) => choices[1] })

		await run()

		expect(select).toHaveBeenCalledWith("Rewind to before which prompt?", [
			"2. Fix the failing test",
			"1. Add a cart module",
		])
		expect(ctx.navigateTree).toHaveBeenCalledWith("u1", { summarize: false })
	})

	it("truncates long prompts and keeps identical prompts distinguishable", async () => {
		const long = "x".repeat(120)
		const { select, run } = setup([userPrompt("u1", "same"), userPrompt("u2", "same"), userPrompt("u3", long)])

		await run()

		const [, choices] = select.mock.calls[0] ?? []
		expect(choices).toEqual([`3. ${"x".repeat(79)}…`, "2. same", "1. same"])
	})

	it("does nothing when the picker is dismissed", async () => {
		const { ctx, run } = setup([userPrompt("u1", "Add a cart module")], { choose: () => undefined })

		await run()

		expect(ctx.navigateTree).not.toHaveBeenCalled()
	})

	it("explains when there is no earlier prompt yet", async () => {
		const { ctx, select, run } = setup([marker])

		await run()

		expect(select).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith("Nothing to rewind to yet.", "info")
	})

	it("waits for the agent to finish instead of rewinding mid-turn", async () => {
		const { ctx, select, run } = setup([userPrompt("u1", "Add a cart module")], { idle: false })

		await run()

		expect(select).not.toHaveBeenCalled()
		expect(ctx.navigateTree).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("once the agent finishes"), "warning")
	})
})
