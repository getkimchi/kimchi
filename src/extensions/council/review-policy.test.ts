import { createHash } from "node:crypto"
import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import type { ChangeSet } from "../../agent-patch/index.js"
import {
	mayDeliberateCouncilAnswer,
	shouldDeliberateCouncilAnswer,
	shouldReviewCouncilCandidate,
	shouldReviewCouncilTurn,
} from "./review-policy.js"

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function toolCall(name: string, args: Record<string, unknown> = {}): AssistantMessage {
	const call: ToolCall = { type: "toolCall", id: `${name}-1`, name, arguments: args }
	return {
		role: "assistant",
		content: [call],
		api: "openai-completions",
		provider: "physical",
		model: "model",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	}
}

function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "physical",
		model: "model",
		usage,
		stopReason: "stop",
		timestamp: 2,
	}
}

function context(...messages: Context["messages"]): Context {
	return { messages }
}

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}

function changeSet(overrides: Partial<ChangeSet>): ChangeSet {
	return {
		transactionId: "tx",
		operations: [],
		base: [],
		patch: "",
		patchSha256: "patch",
		stats: { files: 0, addedLines: 0, removedLines: 0, patchBytes: 0 },
		...overrides,
	}
}

describe("shouldReviewCouncilTurn", () => {
	it("skips direct and read-only tool turns", () => {
		expect(shouldReviewCouncilTurn(context({ role: "user", content: "Explain this", timestamp: 1 }))).toBe(false)
		expect(
			shouldReviewCouncilTurn(
				context(
					{ role: "user", content: "Read three files", timestamp: 1 },
					toolCall("find", { pattern: "src/**/*.ts" }),
					toolCall("read", { path: "src/a.ts" }),
					toolCall("bash", { command: "python3 -c 'print(open(\"src/a.ts\").read())'" }),
				),
			),
		).toBe(false)
	})

	it.each([
		["edit tool", toolCall("edit", { path: "src/a.ts" })],
		["write tool", toolCall("write", { path: "src/a.ts" })],
		["shell edit", toolCall("bash", { command: "sed -i 's/a/b/' src/a.ts" })],
		["shell write", toolCall("bash", { command: "echo changed > src/a.ts" })],
	])("reviews a current-turn %s", (_name, mutation) => {
		expect(shouldReviewCouncilTurn(context({ role: "user", content: "Change it", timestamp: 1 }, mutation))).toBe(true)
	})

	it("ignores changes from an earlier user turn", () => {
		expect(
			shouldReviewCouncilTurn(
				context(
					{ role: "user", content: "Change it", timestamp: 1 },
					toolCall("edit", { path: "src/a.ts" }),
					answer("Changed"),
					{ role: "user", content: "Now just explain it", timestamp: 3 },
					toolCall("read", { path: "src/a.ts" }),
				),
			),
		).toBe(false)
	})

	it("recognizes a successful edit result when the tool-call message is absent", () => {
		expect(
			shouldReviewCouncilTurn(
				context(
					{ role: "user", content: "Change it", timestamp: 1 },
					{
						role: "toolResult",
						toolCallId: "edit-1",
						toolName: "edit",
						content: [{ type: "text", text: "updated" }],
						isError: false,
						timestamp: 2,
					},
				),
			),
		).toBe(true)
	})
})

const SUBSTANTIAL_REQUEST =
	"Research the tradeoffs between our current caching strategy and a write-through cache, and recommend one."
const SUBSTANTIAL_ANSWER = Array.from(
	{ length: 5 },
	(_, index) => `Paragraph ${index}: this line explains part of the answer in enough detail to look substantive.`,
).join("\n")

describe("mayDeliberateCouncilAnswer", () => {
	it("is false for a short request regardless of what the lead might answer", () => {
		expect(mayDeliberateCouncilAnswer(context({ role: "user", content: "hi", timestamp: 1 }))).toBe(false)
	})

	it("is true for a substantial request, before the lead has answered", () => {
		expect(mayDeliberateCouncilAnswer(context({ role: "user", content: SUBSTANTIAL_REQUEST, timestamp: 1 }))).toBe(true)
	})

	it("reads the latest user message when the context has several turns", () => {
		expect(
			mayDeliberateCouncilAnswer(
				context({ role: "user", content: SUBSTANTIAL_REQUEST, timestamp: 1 }, answer("Short reply."), {
					role: "user",
					content: "hi",
					timestamp: 3,
				}),
			),
		).toBe(false)
	})
})

describe("shouldDeliberateCouncilAnswer", () => {
	it("skips a short request even with a long answer", () => {
		expect(
			shouldDeliberateCouncilAnswer(context({ role: "user", content: "hi", timestamp: 1 }), SUBSTANTIAL_ANSWER),
		).toBe(false)
	})

	it("skips a substantial request when the lead's answer is short", () => {
		expect(
			shouldDeliberateCouncilAnswer(
				context({ role: "user", content: SUBSTANTIAL_REQUEST, timestamp: 1 }),
				"Yes, that works.",
			),
		).toBe(false)
	})

	it("deliberates when both the request and the answer are substantial", () => {
		expect(
			shouldDeliberateCouncilAnswer(
				context({ role: "user", content: SUBSTANTIAL_REQUEST, timestamp: 1 }),
				SUBSTANTIAL_ANSWER,
			),
		).toBe(true)
	})

	it("deliberates on a long single-line answer even without multiple lines", () => {
		const longSingleLine = "x".repeat(700)
		expect(
			shouldDeliberateCouncilAnswer(
				context({ role: "user", content: SUBSTANTIAL_REQUEST, timestamp: 1 }),
				longSingleLine,
			),
		).toBe(true)
	})
})

describe("shouldReviewCouncilCandidate", () => {
	it("skips documentation-only candidates", () => {
		expect(
			shouldReviewCouncilCandidate(
				changeSet({
					operations: [{ kind: "update", path: "docs/guide.md", baseSha256: "base", content: "changed\n" }],
					base: [{ path: "docs/guide.md", exists: true, sha256: "base", mode: 0o644 }],
					stats: { files: 1, addedLines: 20, removedLines: 0, patchBytes: 20 },
				}),
			),
		).toBe(false)
	})

	it("skips content-identical renames", () => {
		const content = "guide\n"
		expect(
			shouldReviewCouncilCandidate(
				changeSet({
					operations: [
						{
							kind: "rename",
							fromPath: "README",
							path: "docs/README.md",
							baseSha256: hash(content),
							content,
							mode: 0o644,
						},
					],
					base: [{ path: "README", exists: true, sha256: hash(content), mode: 0o644 }],
					stats: { files: 1, addedLines: 0, removedLines: 0, patchBytes: 20 },
				}),
			),
		).toBe(false)
		expect(
			shouldReviewCouncilCandidate(
				changeSet({
					operations: [
						{
							kind: "rename",
							fromPath: "src/a.ts",
							path: "src/b.ts",
							baseSha256: hash(content),
							content,
							mode: 0o644,
						},
					],
					base: [{ path: "src/a.ts", exists: true, sha256: hash(content), mode: 0o644 }],
					stats: { files: 1, addedLines: 0, removedLines: 0, patchBytes: 20 },
				}),
			),
		).toBe(false)
	})

	it("reviews rename edits and mode-sensitive candidates", () => {
		const content = "guide\n"
		expect(
			shouldReviewCouncilCandidate(
				changeSet({
					operations: [
						{
							kind: "rename",
							fromPath: "README",
							path: "docs/README.md",
							baseSha256: hash(content),
							content: "changed\n",
							mode: 0o644,
						},
					],
					base: [{ path: "README", exists: true, sha256: hash(content), mode: 0o644 }],
					stats: { files: 1, addedLines: 1, removedLines: 1, patchBytes: 20 },
				}),
			),
		).toBe(true)
		expect(
			shouldReviewCouncilCandidate(
				changeSet({
					operations: [{ kind: "create", path: "script.sh", content: "echo ok\n", mode: 0o755 }],
					stats: { files: 1, addedLines: 1, removedLines: 0, patchBytes: 20 },
				}),
			),
		).toBe(true)
	})

	it("reviews tiny updates and deletes of executable files", () => {
		expect(
			shouldReviewCouncilCandidate(
				changeSet({
					operations: [{ kind: "update", path: "bin/tool", baseSha256: "base", content: "changed\n" }],
					base: [{ path: "bin/tool", exists: true, sha256: "base", mode: 0o755 }],
					stats: { files: 1, addedLines: 1, removedLines: 1, patchBytes: 20 },
				}),
			),
		).toBe(true)
		expect(
			shouldReviewCouncilCandidate(
				changeSet({
					operations: [{ kind: "delete", path: "bin/tool", baseSha256: "base" }],
					base: [{ path: "bin/tool", exists: true, sha256: "base", mode: 0o755 }],
					stats: { files: 1, addedLines: 0, removedLines: 1, patchBytes: 20 },
				}),
			),
		).toBe(true)
	})

	it("skips content-identical executable renames without mode changes", () => {
		const content = "#!/bin/sh\necho ok\n"
		expect(
			shouldReviewCouncilCandidate(
				changeSet({
					operations: [
						{
							kind: "rename",
							fromPath: "bin/old-tool",
							path: "bin/new-tool",
							baseSha256: hash(content),
							content,
							mode: 0o755,
						},
					],
					base: [{ path: "bin/old-tool", exists: true, sha256: hash(content), mode: 0o755 }],
					stats: { files: 1, addedLines: 0, removedLines: 0, patchBytes: 20 },
				}),
			),
		).toBe(false)
	})

	it("skips one tiny file and reviews larger or multi-file candidates", () => {
		expect(
			shouldReviewCouncilCandidate(
				changeSet({
					operations: [{ kind: "update", path: "src/a.ts", baseSha256: "base", content: "changed\n" }],
					base: [{ path: "src/a.ts", exists: true, sha256: "base", mode: 0o644 }],
					stats: { files: 1, addedLines: 5, removedLines: 5, patchBytes: 20 },
				}),
			),
		).toBe(false)
		expect(
			shouldReviewCouncilCandidate(
				changeSet({
					operations: [{ kind: "update", path: "src/a.ts", baseSha256: "base", content: "changed\n" }],
					base: [{ path: "src/a.ts", exists: true, sha256: "base", mode: 0o644 }],
					stats: { files: 1, addedLines: 6, removedLines: 5, patchBytes: 20 },
				}),
			),
		).toBe(true)
		expect(
			shouldReviewCouncilCandidate(
				changeSet({
					operations: [
						{ kind: "update", path: "src/a.ts", baseSha256: "base-a", content: "a\n" },
						{ kind: "update", path: "src/b.ts", baseSha256: "base-b", content: "b\n" },
					],
					base: [
						{ path: "src/a.ts", exists: true, sha256: "base-a", mode: 0o644 },
						{ path: "src/b.ts", exists: true, sha256: "base-b", mode: 0o644 },
					],
					stats: { files: 2, addedLines: 2, removedLines: 0, patchBytes: 20 },
				}),
			),
		).toBe(true)
	})
})
