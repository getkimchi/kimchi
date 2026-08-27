import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * Minimal ExtensionContext for testing cwd-sensitive tool execution.
 * The patched tool factories only access ctx.cwd from the context passed to
 * execute, so the remaining fields are stubbed.
 */
function fakeCtx(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("")
}

const toolCallId = "test-call"

/**
 * The cwd passed to create*ToolDefinition at registration time. Tools should
 * ignore this when execute receives a ctx.cwd override.
 */
const creationCwd = "/tmp"

describe("patched cwd-sensitive tools use ctx.cwd from execute", () => {
	let tempDir: string
	let ctx: ExtensionContext

	beforeEach(() => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-tool-cwd-")))
		ctx = fakeCtx(tempDir)
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("read resolves relative paths against ctx.cwd", async () => {
		writeFileSync(join(tempDir, "hello.txt"), "world")
		const tool = createReadToolDefinition(creationCwd)

		const result = await tool.execute(toolCallId, { path: "hello.txt" }, undefined, undefined, ctx)

		expect(getText(result)).toContain("world")
	})

	it("write creates files relative to ctx.cwd", async () => {
		const tool = createWriteToolDefinition(creationCwd)

		const result = await tool.execute(
			toolCallId,
			{ path: "new-file.txt", content: "written" },
			undefined,
			undefined,
			ctx,
		)

		expect(getText(result)).toBeTruthy()
		expect(readFileSync(join(tempDir, "new-file.txt"), "utf-8")).toBe("written")
	})

	it("edit modifies files relative to ctx.cwd", async () => {
		writeFileSync(join(tempDir, "edit-me.txt"), "old content")
		const tool = createEditToolDefinition(creationCwd)

		const result = await tool.execute(
			toolCallId,
			{ path: "edit-me.txt", edits: [{ oldText: "old", newText: "new" }] },
			undefined,
			undefined,
			ctx,
		)

		expect(getText(result)).toBeTruthy()
		expect(readFileSync(join(tempDir, "edit-me.txt"), "utf-8")).toBe("new content")
	})

	it("grep searches under ctx.cwd", async () => {
		writeFileSync(join(tempDir, "needle.txt"), "find me here")
		const tool = createGrepToolDefinition(creationCwd)

		const result = await tool.execute(toolCallId, { pattern: "find me" }, undefined, undefined, ctx)

		expect(getText(result)).toContain("needle.txt")
	})

	it("find discovers files under ctx.cwd", async () => {
		writeFileSync(join(tempDir, "target.txt"), "")
		const tool = createFindToolDefinition(creationCwd)

		const result = await tool.execute(toolCallId, { pattern: "*.txt" }, undefined, undefined, ctx)

		expect(getText(result)).toContain("target.txt")
	})

	it("ls lists ctx.cwd", async () => {
		writeFileSync(join(tempDir, "visible.txt"), "")
		const tool = createLsToolDefinition(creationCwd)

		const result = await tool.execute(toolCallId, { path: "." }, undefined, undefined, ctx)

		expect(getText(result)).toContain("visible.txt")
	})

	it("bash executes with ctx.cwd as working directory", async () => {
		// Disable session environment so resolveSpawnContext does not touch
		// sessionManager internals; only cwd matters for this test.
		const tool = createBashToolDefinition(creationCwd, { exposeSessionEnvironment: false })

		const result = await tool.execute(
			toolCallId,
			{ command: process.platform === "win32" ? "cd" : "pwd" },
			undefined,
			undefined,
			ctx,
		)

		expect(getText(result).trim()).toBe(tempDir)
	})
})
