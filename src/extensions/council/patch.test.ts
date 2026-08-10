import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ChangeTransaction } from "../../agent-patch/index.js"
import type { StagePatchSuccess } from "./patch.js"
import { CANDIDATE_PATCH_SCHEMA, CandidatePatchSchema, renderPatchDiff, stagePatch } from "./patch.js"

const roots: string[] = []

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "council-patch-"))
	roots.push(root)
	return root
}

function success(result: Awaited<ReturnType<typeof stagePatch>>): StagePatchSuccess {
	if (!result.ok) throw result.error
	return result
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("CandidatePatchSchema", () => {
	it("accepts the complete file-operation shape", () => {
		expect(JSON.parse(CANDIDATE_PATCH_SCHEMA)).toMatchObject({
			type: "object",
			required: ["operations"],
		})
		const patch = CandidatePatchSchema.parse({
			operations: [
				{ op: "create", path: "create.txt", content: "created\n" },
				{ op: "update", path: "update.txt", content: "updated\n" },
				{ op: "delete", path: "delete.txt" },
				{ op: "rename", path: "rename.txt", new_path: "renamed.txt" },
			],
		})

		expect(patch.operations).toHaveLength(4)
	})

	it("rejects unsafe, duplicate, unknown, and colliding operations", () => {
		expect(() =>
			CandidatePatchSchema.parse({ operations: [{ op: "create", path: "../escape", content: "" }] }),
		).toThrow()
		expect(() =>
			CandidatePatchSchema.parse({ operations: [{ op: "create", path: "/absolute", content: "" }] }),
		).toThrow()
		expect(() =>
			CandidatePatchSchema.parse({
				operations: [
					{ op: "create", path: "same.txt", content: "one" },
					{ op: "update", path: "same.txt", content: "two" },
				],
			}),
		).toThrow(/Duplicate or colliding/)
		expect(() =>
			CandidatePatchSchema.parse({
				operations: [
					{ op: "rename", path: "source.txt", new_path: "target.txt" },
					{ op: "create", path: "target.txt", content: "collision" },
				],
			}),
		).toThrow(/Duplicate or colliding/)
		expect(() => CandidatePatchSchema.parse({ operations: [{ op: "unknown", path: "file.txt" }] })).toThrow()
	})

	it("rejects null bytes, backslashes, and denormalized paths", () => {
		const reject = (path: string) =>
			expect(() => CandidatePatchSchema.parse({ operations: [{ op: "create", path, content: "" }] })).toThrow()

		reject("null\u0000byte.txt")
		reject("windows\\style.txt")
		reject("./unnormalized.txt")
		reject("nested/../escape.txt")
		reject("cafe\u0301.txt")
		expect(
			CandidatePatchSchema.parse({ operations: [{ op: "create", path: "caf\u00e9.txt", content: "" }] }).operations,
		).toHaveLength(1)
	})
})

describe("stagePatch", () => {
	it("round-trips create, update, delete, and rename through one transaction", async () => {
		const root = fixture()
		writeFileSync(join(root, "update.txt"), "before update\n")
		writeFileSync(join(root, "delete.txt"), "delete me\n")
		writeFileSync(join(root, "rename.txt"), "rename me\n")
		const transaction = new ChangeTransaction(root)

		const result = success(
			await stagePatch(transaction, {
				operations: [
					{ op: "create", path: "create.txt", content: "created\n" },
					{ op: "update", path: "update.txt", content: "updated\n" },
					{ op: "delete", path: "delete.txt" },
					{ op: "rename", path: "rename.txt", new_path: "renamed.txt" },
				],
			}),
		)

		expect(result.changeSet.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "create", path: "create.txt", content: "created\n" }),
				expect.objectContaining({ kind: "update", path: "update.txt", content: "updated\n" }),
				expect.objectContaining({ kind: "delete", path: "delete.txt" }),
				expect.objectContaining({
					kind: "rename",
					fromPath: "rename.txt",
					path: "renamed.txt",
					content: "rename me\n",
				}),
			]),
		)
		expect(result.changeSet.operations).toHaveLength(4)
		expect(readFileSync(join(root, "update.txt"), "utf8")).toBe("before update\n")
		expect(transaction.state).toBe("staging")
	})

	it("rejects an oversized patch using the transaction limits", async () => {
		const root = fixture()
		const transaction = new ChangeTransaction(root)
		const result = await stagePatch(transaction, {
			operations: Array.from({ length: 65 }, (_, index) => ({
				op: "create",
				path: `file-${index}.txt`,
				content: "content\n",
			})),
		})

		expect(result).toMatchObject({ ok: false, code: "limits" })
		expect(() => readFileSync(join(root, "file-0.txt"))).toThrow()
	})

	it("rejects a patch that exceeds the changed-line limit", async () => {
		const root = fixture()
		const transaction = new ChangeTransaction(root)
		const result = await stagePatch(transaction, {
			operations: [{ op: "create", path: "huge.txt", content: "line\n".repeat(12_001) }],
		})

		expect(result).toMatchObject({ ok: false, code: "limits" })
		expect(() => readFileSync(join(root, "huge.txt"))).toThrow()
		expect(transaction.changeSet().operations).toHaveLength(0)
	})

	it("rejects a patch that exceeds the patch-byte limit", async () => {
		const root = fixture()
		const transaction = new ChangeTransaction(root)
		const result = await stagePatch(transaction, {
			operations: Array.from({ length: 8 }, (_, index) => ({
				op: "create",
				path: `bulk-${index}.txt`,
				content: `${"x".repeat(999)}\n`.repeat(70),
			})),
		})

		expect(result).toMatchObject({ ok: false, code: "limits" })
		expect(transaction.changeSet().operations).toHaveLength(0)
	})

	it("fails closed when the transaction base has drifted", async () => {
		const root = fixture()
		const path = join(root, "file.txt")
		writeFileSync(path, "base\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("file.txt", "candidate\n")
		writeFileSync(path, "drifted\n")

		const result = await stagePatch(transaction, {
			operations: [{ op: "create", path: "new.txt", content: "new\n" }],
		})

		expect(result).toMatchObject({ ok: false, code: "base_drift" })
		expect(readFileSync(path, "utf8")).toBe("drifted\n")
	})

	it("uses the staged mutation guards for directories", async () => {
		const root = fixture()
		mkdirSync(join(root, "folder"))
		const result = await stagePatch(new ChangeTransaction(root), {
			operations: [{ op: "update", path: "folder", content: "not a file" }],
		})

		expect(result).toMatchObject({ ok: false, code: "transaction" })
	})

	it("rejects a create that collides with an existing path", async () => {
		const root = fixture()
		writeFileSync(join(root, "exists.txt"), "already here\n")
		const result = await stagePatch(new ChangeTransaction(root), {
			operations: [{ op: "create", path: "exists.txt", content: "rewritten\n" }],
		})

		expect(result).toMatchObject({ ok: false, code: "path" })
		expect(readFileSync(join(root, "exists.txt"), "utf8")).toBe("already here\n")
	})

	it("rejects an update on a path that does not exist", async () => {
		const root = fixture()
		const result = await stagePatch(new ChangeTransaction(root), {
			operations: [{ op: "update", path: "missing.txt", content: "content\n" }],
		})

		expect(result.ok).toBe(false)
		expect(() => readFileSync(join(root, "missing.txt"))).toThrow()
	})

	it("rejects a traversal path via the schema before staging", async () => {
		const root = fixture()
		const result = await stagePatch(new ChangeTransaction(root), {
			operations: [{ op: "create", path: "../escape.txt", content: "x" }],
		})

		expect(result).toMatchObject({ ok: false, code: "invalid_patch" })
	})
})

describe("renderPatchDiff", () => {
	it("renders rename and delete diffs from real base bytes", async () => {
		const root = fixture()
		writeFileSync(join(root, "old.txt"), "old base line\n")
		writeFileSync(join(root, "remove.txt"), "remove base line\n")
		const transaction = new ChangeTransaction(root)

		const diff = await renderPatchDiff(transaction, {
			operations: [
				{ op: "rename", path: "old.txt", new_path: "moved.txt" },
				{ op: "delete", path: "remove.txt" },
			],
		})

		expect(diff).toContain("# rename old.txt -> moved.txt")
		expect(diff).toContain("--- old.txt")
		expect(diff).toContain("-old base line")
		expect(diff).toContain("--- moved.txt")
		expect(diff).toContain("+old base line")
		expect(diff).toContain("# delete remove.txt")
		expect(diff).toContain("-remove base line")
	})

	it("honors a byte bound with an explicit truncation marker", async () => {
		const root = fixture()
		writeFileSync(join(root, "base.txt"), "base\n")
		const diff = await renderPatchDiff(
			new ChangeTransaction(root),
			{ operations: [{ op: "update", path: "base.txt", content: "x".repeat(1000) }] },
			{ maxBytes: 128 },
		)

		expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(128)
		expect(diff).toContain("diff truncated")
	})

	it("renders a create against an existing path instead of throwing", async () => {
		const root = fixture()
		writeFileSync(join(root, "exists.txt"), "already here\n")
		const transaction = new ChangeTransaction(root)

		const diff = await renderPatchDiff(transaction, {
			operations: [{ op: "create", path: "exists.txt", content: "rewritten\n" }],
		})

		expect(diff).toContain("# create exists.txt")
		expect(diff).toContain("-already here")
		expect(diff).toContain("+rewritten")
	})

	it("renders update, delete, and rename against a missing base instead of throwing", async () => {
		const root = fixture()
		const transaction = new ChangeTransaction(root)

		const diff = await renderPatchDiff(transaction, {
			operations: [
				{ op: "update", path: "missing-update.txt", content: "new content\n" },
				{ op: "delete", path: "missing-delete.txt" },
				{ op: "rename", path: "missing-rename.txt", new_path: "missing-renamed.txt" },
			],
		})

		expect(diff).toContain("# update missing-update.txt")
		expect(diff).toContain("+new content")
		expect(diff).toContain("# delete missing-delete.txt")
		expect(diff).toContain("# rename missing-rename.txt -> missing-renamed.txt")
	})

	it("renders a mixed patch of several unrenderable-by-old-rules operations without throwing", async () => {
		const root = fixture()
		writeFileSync(join(root, "collide.txt"), "collision base\n")
		const transaction = new ChangeTransaction(root)

		const diff = await renderPatchDiff(transaction, {
			operations: [
				{ op: "create", path: "collide.txt", content: "rewritten\n" },
				{ op: "update", path: "gone.txt", content: "content\n" },
				{ op: "delete", path: "also-gone.txt" },
			],
		})

		expect(diff).toContain("# create collide.txt")
		expect(diff).toContain("# update gone.txt")
		expect(diff).toContain("# delete also-gone.txt")
	})
})
