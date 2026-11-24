import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import reviewSubmitExtension from "./index.js"

const validSummary = {
	body: "Path test summary.",
	score: 90,
	estimated_effort_to_review: 2,
	environment_gaps: [],
}

const validFinding = {
	path: "main.go",
	line: 999,
	severity: "warning",
	type: "bug",
	description: "Context traversal test finding.",
	suggestion: "Do not read or write through the symlink.",
}

describe("reviewSubmitExtension", () => {
	const temporaryDirectories: string[] = []
	let projectDir: string
	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "kimchi-review-path-test-"))
		temporaryDirectories.push(projectDir)
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
	})

	function activeHarness(overrides: Record<string, string | undefined> = {}) {
		vi.stubEnv("REVIEW_WRITER", "final")
		const harness = createExtensionApi()
		harness.api.getFlag = vi.fn((name: string) => overrides[name])
		reviewSubmitExtension(harness.api)
		return harness
	}

	it("registers path flags but no tools in an ordinary session without side effects", () => {
		vi.stubEnv("REVIEW_WRITER", "")
		const harness = createExtensionApi()
		reviewSubmitExtension(harness.api)
		expect(harness.getRegisteredTools()).toEqual([])
		expect(vi.mocked(harness.api.registerFlag).mock.calls.map(([name]) => name)).toEqual([
			"review-context-dir",
			"review-output-dir",
		])
		expect(readdirSync(projectDir)).toEqual([])
	})

	it("registers all three tools and both string path flags when comments.json is absent", () => {
		const harness = activeHarness()
		expect(harness.getActiveToolNames()).toEqual(["submit_finding", "submit_summary", "submit_reply"])
		expect(vi.mocked(harness.api.registerFlag).mock.calls.map(([name]) => name)).toEqual([
			"review-context-dir",
			"review-output-dir",
		])
		expect(vi.mocked(harness.api.registerFlag).mock.calls.map(([, options]) => options.type)).toEqual([
			"string",
			"string",
		])
	})

	it("uses the project .kimchi directories by default, never HOME", async () => {
		const harness = activeHarness()
		const result = await harness
			.getRegisteredTool("submit_summary")
			.execute("default-path", validSummary, undefined, undefined, createToolContext({ cwd: projectDir }))
		expect(result.details).toMatchObject({ accepted: true })
		expect(
			JSON.parse(readFileSync(join(projectDir, ".kimchi", "review-output", "summary", "final.json"), "utf8")),
		).toMatchObject({
			body: validSummary.body,
			writer: "final",
		})
		expect(existsSync(join(process.env.HOME ?? "", "review-output"))).toBe(false)
	})

	it("resolves both relative flag values against ctx.cwd", async () => {
		const harness = activeHarness({
			"review-context-dir": "provider/review-context",
			"review-output-dir": "artifacts/review-output",
		})
		const result = await harness
			.getRegisteredTool("submit_summary")
			.execute("relative-path", validSummary, undefined, undefined, createToolContext({ cwd: projectDir }))
		expect(result.details).toMatchObject({ accepted: true })
		expect(existsSync(join(projectDir, "artifacts", "review-output", "summary", "final.json"))).toBe(true)
		expect(existsSync(join(projectDir, ".kimchi", "review-output"))).toBe(false)
	})

	it("rejects a symlinked .kimchi directory without writing outside", async () => {
		const external = mkdtempSync(join(tmpdir(), "kimchi-review-kimchi-link-external-"))
		temporaryDirectories.push(external)
		symlinkSync(external, join(projectDir, ".kimchi"), "dir")
		const harness = activeHarness()
		const result = await harness
			.getRegisteredTool("submit_finding")
			.execute("kimchi-link", validFinding, undefined, undefined, createToolContext({ cwd: projectDir }))
		expect(result.details).toMatchObject({ accepted: false, reason: "output_path" })
		expect(readdirSync(external)).toEqual([])
	})

	it("rejects a symlinked default review output leaf", async () => {
		const external = mkdtempSync(join(tmpdir(), "kimchi-review-output-link-external-"))
		temporaryDirectories.push(external)
		mkdirSync(join(projectDir, ".kimchi"))
		symlinkSync(external, join(projectDir, ".kimchi", "review-output"), "dir")
		const harness = activeHarness()
		const result = await harness
			.getRegisteredTool("submit_finding")
			.execute("default-output-link", validFinding, undefined, undefined, createToolContext({ cwd: projectDir }))
		expect(result.details).toMatchObject({ accepted: false, reason: "output_path" })
		expect(readdirSync(external)).toEqual([])
	})

	it("rejects .kimchi when it is a regular file", async () => {
		writeFileSync(join(projectDir, ".kimchi"), "not a directory")
		const harness = activeHarness()
		const result = await harness
			.getRegisteredTool("submit_finding")
			.execute("kimchi-file", validFinding, undefined, undefined, createToolContext({ cwd: projectDir }))
		expect(result.details).toMatchObject({ accepted: false, reason: "output_path" })
	})

	it("treats symlinked default context as missing without reading outside", async () => {
		mkdirSync(join(projectDir, ".kimchi"))
		const external = mkdtempSync(join(tmpdir(), "kimchi-review-context-link-external-"))
		temporaryDirectories.push(external)
		writeFileSync(
			join(external, "commentable-lines.json"),
			JSON.stringify({
				schema_version: "commentable-lines/v1",
				files: { "main.go": { ranges: [{ start_line: 1, end_line: 1 }] } },
			}),
		)
		writeFileSync(
			join(external, "comments.json"),
			JSON.stringify({
				schema_version: "review-comments/v1",
				threads: [{ thread_id: "external-thread", is_ours: false, mentions_bot: true }],
			}),
		)
		symlinkSync(external, join(projectDir, ".kimchi", "review-context"), "dir")
		const harness = activeHarness()
		const findingResult = await harness
			.getRegisteredTool("submit_finding")
			.execute("context-link-finding", validFinding, undefined, undefined, createToolContext({ cwd: projectDir }))
		// The out-of-range line is accepted because the linked anchor map was
		// never read. Without a valid map, local anchors remain unchecked.
		expect(findingResult.details).toMatchObject({ accepted: true, id: "final-1" })
		const replyResult = await harness
			.getRegisteredTool("submit_reply")
			.execute(
				"context-link-reply",
				{ thread_id: "external-thread", body: "Must not use linked context.", action: "none" },
				undefined,
				undefined,
				createToolContext({ cwd: projectDir }),
			)
		expect(replyResult.details).toMatchObject({ accepted: false, reason: "thread_context_missing" })
		expect(existsSync(join(projectDir, ".kimchi", "review-output", "replies", "final.jsonl"))).toBe(false)
		expect(readdirSync(external).sort()).toEqual(["commentable-lines.json", "comments.json"])
	})

	it("allows a flag-selected output beneath a symlinked ancestor", async () => {
		const actualBase = mkdtempSync(join(tmpdir(), "kimchi-review-link-ancestor-real-"))
		temporaryDirectories.push(actualBase)
		symlinkSync(actualBase, join(projectDir, "linked-ancestor"), "dir")
		const harness = activeHarness({
			"review-context-dir": join(projectDir, "linked-ancestor", "input", "review-context"),
			"review-output-dir": join(projectDir, "linked-ancestor", "nested", "review-output"),
		})
		const result = await harness
			.getRegisteredTool("submit_summary")
			.execute("linked-ancestor", validSummary, undefined, undefined, createToolContext({ cwd: projectDir }))
		expect(result.details).toMatchObject({ accepted: true })
		expect(existsSync(join(actualBase, "nested", "review-output", "summary", "final.json"))).toBe(true)
		expect(existsSync(join(actualBase, "linked-ancestor"))).toBe(false)
	})

	it("rejects a flag-selected symlinked output directory", async () => {
		const external = mkdtempSync(join(tmpdir(), "kimchi-review-path-external-"))
		temporaryDirectories.push(external)
		symlinkSync(external, join(projectDir, "linked-output"), "dir")
		const harness = activeHarness({ "review-output-dir": "linked-output" })
		const result = await harness
			.getRegisteredTool("submit_summary")
			.execute("symlink-flag", validSummary, undefined, undefined, createToolContext({ cwd: projectDir }))
		expect(result.details).toMatchObject({ accepted: false, reason: "output_path" })
		expect(readdirSync(external)).toEqual([])
	})
})
