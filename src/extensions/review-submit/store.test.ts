import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runSubmissionProcess } from "./process-test-utils.js"
import { REPLY_SCHEMA_VERSION, submitFinding, submitReply, submitSummary } from "./store.js"

const NOW = () => new Date("2026-11-17T12:00:00Z")

describe("review submit store", () => {
	let homeDir: string
	beforeEach(async () => {
		homeDir = mkdtempSync(join(tmpdir(), "kimchi-review-store-"))
		await mkdir(join(homeDir, "review-context"), { recursive: true })
	})
	afterEach(() => rmSync(homeDir, { recursive: true, force: true }))

	it("rejects every reply with a clear reason when thread context is absent", async () => {
		const result = await submitReply(
			{ thread_id: "thread-1", body: "Done.", action: "none" },
			{ homeDir, writer: "final", now: NOW },
		)
		expect(result).toMatchObject({ accepted: false, reason: "thread_context_missing" })
		expect(result.message).toContain("review-context/comments.json is absent")
		expect(existsSync(join(homeDir, "review-output"))).toBe(false)
	})

	it("enforces reply scope and persists exactly, including the 30-reply cap after a process restart", async () => {
		writeFileSync(
			join(homeDir, "review-context", "comments.json"),
			JSON.stringify({
				schema_version: "review-comments/v1",
				threads: [
					{ thread_id: "ours", is_ours: true, mentions_bot: false },
					{ thread_id: "mention", is_ours: false, mentions_bot: true },
					{
						thread_id: "read-only",
						is_ours: false,
						mentions_bot: false,
						comments: [{ author: "human", role: "author", body: "@review-bot only in the body" }],
					},
				],
			}),
		)
		const context = { homeDir, writer: "final", now: NOW }
		const own = await submitReply(
			{
				thread_id: "ours",
				body: "The guard now covers this path.",
				action: "resolve",
				verdict: "fixed",
				evidence_kind: "new_test",
				evidence: "The new regression test failed before and passes at head.",
			},
			context,
		)
		expect(own).toMatchObject({ accepted: true, id: "final-1", seq: 1 })
		const mention = await submitReply(
			{ thread_id: "mention", body: "This is explained by the guard.", action: "none" },
			context,
		)
		expect(mention).toMatchObject({ accepted: true, id: "final-2", seq: 2 })
		expect((await submitReply({ thread_id: "mention", body: "No.", action: "resolve" }, context)).reason).toBe(
			"thread_action_forbidden",
		)
		expect((await submitReply({ thread_id: "read-only", body: "No.", action: "none" }, context)).reason).toBe(
			"thread_out_of_scope",
		)
		expect((await submitReply({ thread_id: "missing", body: "No.", action: "none" }, context)).reason).toBe(
			"thread_not_found",
		)
		expect((await submitReply({ thread_id: "ours", body: "Incomplete.", action: "none" }, context)).field).toBe(
			"verdict",
		)
		expect(
			(await submitReply({ thread_id: "ours", body: "Incomplete.", action: "none", verdict: "unverified" }, context))
				.field,
		).toBe("evidence_kind")
		expect(
			(
				await submitReply(
					{ thread_id: "ours", body: "Incomplete.", action: "none", verdict: "unverified", evidence_kind: "none" },
					context,
				)
			).field,
		).toBe("evidence")
		expect((await submitReply({ thread_id: "mention", body: "Bad action.", action: "delete" }, context)).reason).toBe(
			"invalid_field",
		)

		const readRecords = () =>
			readFileSync(join(homeDir, "review-output", "replies", "final.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		const expectedInitial = [
			{
				schema_version: REPLY_SCHEMA_VERSION,
				id: "final-1",
				writer: "final",
				seq: 1,
				created_at: "2026-11-17T12:00:00Z",
				thread_id: "ours",
				body: "The guard now covers this path.",
				action: "resolve",
				verdict: "fixed",
				evidence_kind: "new_test",
				evidence: "The new regression test failed before and passes at head.",
			},
			{
				schema_version: REPLY_SCHEMA_VERSION,
				id: "final-2",
				writer: "final",
				seq: 2,
				created_at: "2026-11-17T12:00:00Z",
				thread_id: "mention",
				body: "This is explained by the guard.",
				action: "none",
			},
		]
		expect(readRecords()).toEqual(expectedInitial)

		for (let index = 0; index < 28; index += 1) {
			expect(
				(await submitReply({ thread_id: "mention", body: `Reply ${index}`, action: "none" }, context)).accepted,
			).toBe(true)
		}
		const capped = await runSubmissionProcess({
			tool: "submit_reply",
			homeDir,
			input: { thread_id: "mention", body: "One too many.", action: "none" },
		})
		expect(capped.result).toMatchObject({ accepted: false, reason: "cap", count: 30, limit: 30 })
		const expectedAll = [
			...expectedInitial,
			...Array.from({ length: 28 }, (_, index) => ({
				schema_version: REPLY_SCHEMA_VERSION,
				id: `final-${index + 3}`,
				writer: "final",
				seq: index + 3,
				created_at: "2026-11-17T12:00:00Z",
				thread_id: "mention",
				body: `Reply ${index}`,
				action: "none",
			})),
		]
		expect(readRecords()).toEqual(expectedAll)
	})

	it.each([
		null,
		[],
		42,
		{},
		{ threads: [] },
		{ schema_version: "review-comments/v2", threads: [] },
		{ schema_version: "review-comments/v1" },
		{ schema_version: "review-comments/v1", threads: null },
		{ schema_version: "review-comments/v1", threads: [null] },
		{ schema_version: "review-comments/v1", threads: [[null]] },
		{
			schema_version: "review-comments/v1",
			threads: [{ id: "remote", ours: true, bot_mentioned: true }],
		},
		{
			schema_version: "review-comments/v1",
			threads: [{ thread_id: null, is_ours: true, mentions_bot: false }],
		},
		{
			schema_version: "review-comments/v1",
			threads: [{ thread_id: "mine", is_ours: true }],
		},
		{
			schema_version: "review-comments/v1",
			threads: [{ thread_id: "mine", is_ours: "true", mentions_bot: false }],
		},
		{
			schema_version: "review-comments/v1",
			threads: [{ thread_id: "mention", is_ours: false, mentions_bot: "yes" }],
		},
	])("rejects malformed reply context %# without writing output", async (comments) => {
		writeFileSync(join(homeDir, "review-context", "comments.json"), JSON.stringify(comments))
		const result = await submitReply(
			{ thread_id: "mine", body: "Done.", action: "none" },
			{ homeDir, writer: "final", now: NOW },
		)
		expect(result).toMatchObject({ accepted: false, reason: "invalid_context" })
		expect(readdirSync(homeDir)).not.toContain("review-output")
	})

	it("keeps final at 50 while honoring a lower limit for other writers", async () => {
		const finding = {
			path: "local.ts",
			line: 1,
			severity: "warning",
			type: "bug",
			description: "A local finding.",
			suggestion: "Fix it.",
		}
		const finalContext = { homeDir, writer: "final", writerLimit: 1, now: NOW }
		expect((await submitFinding(finding, finalContext)).accepted).toBe(true)
		expect((await submitFinding(finding, finalContext)).accepted).toBe(true)
		const otherContext = { homeDir, writer: "correctness", writerLimit: 1, now: NOW }
		expect((await submitFinding(finding, otherContext)).accepted).toBe(true)
		expect(await submitFinding(finding, otherContext)).toMatchObject({
			accepted: false,
			reason: "cap",
			count: 1,
			limit: 1,
		})
	})

	it("rejects an unsupported anchor-map schema without writing output", async () => {
		writeFileSync(
			join(homeDir, "review-context", "commentable-lines.json"),
			JSON.stringify({ schema_version: "future/v9", files: {} }),
		)
		const result = await submitFinding(
			{
				path: "main.go",
				line: 1,
				severity: "warning",
				type: "bug",
				description: "Unknown schema.",
				suggestion: "Stop.",
			},
			{ homeDir, writer: "final", now: NOW },
		)
		expect(result).toMatchObject({ accepted: false, reason: "invalid_context", field: "schema_version" })
		expect(existsSync(join(homeDir, "review-output"))).toBe(false)
	})

	it("rejects NUL in finding, summary, gap, and reply fields", async () => {
		writeFileSync(
			join(homeDir, "review-context", "comments.json"),
			JSON.stringify({
				schema_version: "review-comments/v1",
				threads: [{ thread_id: "mention", is_ours: false, mentions_bot: true }],
			}),
		)
		const finding = await submitFinding(
			{
				path: "main.go",
				line: 1,
				severity: "warning",
				type: "bug",
				description: "bad\0description",
				suggestion: "Stop.",
			},
			{ homeDir, writer: "final", now: NOW },
		)
		expect(finding).toMatchObject({ accepted: false, reason: "invalid_field", field: "description" })
		const summary = await submitSummary(
			{ body: "body", environment_gaps: [{ kind: "missing_tool", name: "bad\0tool", note: "missing" }] },
			{ homeDir, writer: "final", now: NOW },
		)
		expect(summary).toMatchObject({ accepted: false, reason: "invalid_field", field: "environment_gaps[0].name" })
		const reply = await submitReply(
			{ thread_id: "mention", body: "bad\0body", action: "none" },
			{ homeDir, writer: "final", now: NOW },
		)
		expect(reply).toMatchObject({ accepted: false, reason: "invalid_field", field: "body" })
	})
})
