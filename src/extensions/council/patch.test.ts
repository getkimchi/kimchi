import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChangeTransaction } from "../../agent-patch/index.js"
import {
	CANDIDATE_PATCH_SCHEMA,
	CandidatePatchSchema,
	materializeCandidateWorkspace,
	renderPatchDiff,
	runCandidateCheck,
	type StagePatchSuccess,
	stagePatch,
} from "./patch.js"
import type { ValidationCheck } from "./validation.js"

const { createdWorkspaceDirs } = vi.hoisted(() => ({ createdWorkspaceDirs: [] as string[] }))

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>()
	return {
		...actual,
		mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
			const result = await actual.mkdtemp(...args)
			if (typeof args[0] === "string" && args[0].includes("kimchi-council-check-")) createdWorkspaceDirs.push(result)
			return result
		},
	}
})

const execFileAsync = promisify(execFile)

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

const candidateCheckRoots: string[] = []

async function candidateCheckFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "council-candidate-check-"))
	candidateCheckRoots.push(root)
	return root
}

function echoCheck(overrides: Partial<ValidationCheck> = {}): ValidationCheck {
	return {
		id: "candidate.echo",
		kind: "test",
		cwd: ".",
		executable: "node",
		args: ["-e", "process.stdout.write(require('fs').readFileSync('greeting.txt','utf8'))"],
		timeoutMs: 5_000,
		mutationPolicy: "read-only",
		expectedOutputs: [],
		...overrides,
	}
}

async function snapshotTree(root: string, cursor = "."): Promise<Map<string, string>> {
	const snapshot = new Map<string, string>()
	const entries = await readdir(join(root, cursor), { withFileTypes: true })
	for (const entry of entries) {
		const relativePath = cursor === "." ? entry.name : `${cursor}/${entry.name}`
		if (entry.isSymbolicLink()) continue
		if (entry.isDirectory()) {
			for (const [path, hash] of await snapshotTree(root, relativePath)) snapshot.set(path, hash)
		} else if (entry.isFile()) {
			snapshot.set(relativePath, (await readFile(join(root, relativePath))).toString("base64"))
		}
	}
	return snapshot
}

afterEach(async () => {
	createdWorkspaceDirs.length = 0
	await Promise.all(candidateCheckRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("candidate-check", () => {
	it("runs the check against the candidate's content, not the on-disk original", async () => {
		const root = await candidateCheckFixture()
		await writeFile(join(root, "greeting.txt"), "original\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("greeting.txt", "candidate\n")
		const changeSet = transaction.changeSet()

		const outcome = await runCandidateCheck(root, changeSet, echoCheck(), 5_000)

		expect(outcome).toMatchObject({ id: "candidate.echo", kind: "test", ok: true, exitCode: 0, timedOut: false })
		expect(outcome.output).toContain("candidate")
		expect(outcome.output).not.toContain("original")
		expect(await readFile(join(root, "greeting.txt"), "utf8")).toBe("original\n")
	})

	it("leaves the real workspace byte-identical before and after a check runs", async () => {
		const root = await candidateCheckFixture()
		await writeFile(join(root, "a.txt"), "alpha\n")
		await mkdir(join(root, "nested"))
		await writeFile(join(root, "nested", "b.txt"), "beta\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("a.txt", "alpha candidate\n")
		const changeSet = transaction.changeSet()
		const before = await snapshotTree(root)

		const outcome = await runCandidateCheck(root, changeSet, echoCheck({ args: ["-e", "process.exit(0)"] }), 5_000)

		expect(outcome.ok).toBe(true)
		expect(await snapshotTree(root)).toEqual(before)
	})

	it("materializes only the workspace's own tracked and visible files under git, never the ignored ones", async () => {
		const root = await candidateCheckFixture()
		await writeFile(join(root, "tracked.txt"), "tracked\n")
		await writeFile(join(root, ".gitignore"), "ignored.txt\n")
		await execFileAsync("git", ["init", "-q"], { cwd: root })
		await execFileAsync("git", ["add", "-A"], { cwd: root })
		await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root })
		await writeFile(join(root, "ignored.txt"), "should not appear\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("tracked.txt", "tracked candidate\n")
		const changeSet = transaction.changeSet()

		const workspace = await materializeCandidateWorkspace(root, changeSet)
		try {
			const entries = await readdir(workspace.root)
			expect(entries).toEqual(expect.arrayContaining(["tracked.txt", ".gitignore"]))
			expect(entries).not.toContain("ignored.txt")
			expect(await readFile(join(workspace.root, "tracked.txt"), "utf8")).toBe("tracked candidate\n")
		} finally {
			await workspace.cleanup()
		}
	})

	it("falls back to a full directory walk outside a git repository", async () => {
		const root = await candidateCheckFixture()
		await writeFile(join(root, "plain.txt"), "plain\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("plain.txt", "plain candidate\n")
		const changeSet = transaction.changeSet()

		const workspace = await materializeCandidateWorkspace(root, changeSet)
		try {
			expect(await readFile(join(workspace.root, "plain.txt"), "utf8")).toBe("plain candidate\n")
		} finally {
			await workspace.cleanup()
		}
	})

	it("reuses node_modules and .git by symlink instead of copying them", async () => {
		const root = await candidateCheckFixture()
		await mkdir(join(root, "node_modules", "pkg"), { recursive: true })
		await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1\n")
		await execFileAsync("git", ["init", "-q"], { cwd: root })
		await writeFile(join(root, "file.txt"), "content\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("file.txt", "content candidate\n")
		const changeSet = transaction.changeSet()

		const workspace = await materializeCandidateWorkspace(root, changeSet)
		try {
			expect((await lstat(join(workspace.root, "node_modules"))).isSymbolicLink()).toBe(true)
			expect((await lstat(join(workspace.root, ".git"))).isSymbolicLink()).toBe(true)
			expect(await readFile(join(workspace.root, "node_modules", "pkg", "index.js"), "utf8")).toBe(
				"module.exports = 1\n",
			)
		} finally {
			await workspace.cleanup()
		}
	})

	it("removes the temporary workspace after a successful check", async () => {
		const root = await candidateCheckFixture()
		await writeFile(join(root, "file.txt"), "content\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("file.txt", "candidate\n")
		const changeSet = transaction.changeSet()

		await runCandidateCheck(root, changeSet, echoCheck({ args: ["-e", "process.exit(0)"] }), 5_000)

		expect(createdWorkspaceDirs).toHaveLength(1)
		await expect(lstat(createdWorkspaceDirs[0])).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("removes the temporary workspace when the check exits non-zero", async () => {
		const root = await candidateCheckFixture()
		await writeFile(join(root, "file.txt"), "content\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("file.txt", "candidate\n")
		const changeSet = transaction.changeSet()

		const outcome = await runCandidateCheck(root, changeSet, echoCheck({ args: ["-e", "process.exit(1)"] }), 5_000)

		expect(outcome).toMatchObject({ ok: false, exitCode: 1 })
		expect(createdWorkspaceDirs).toHaveLength(1)
		await expect(lstat(createdWorkspaceDirs[0])).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("removes the temporary workspace when the run is aborted", async () => {
		const root = await candidateCheckFixture()
		await writeFile(join(root, "file.txt"), "content\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("file.txt", "candidate\n")
		const changeSet = transaction.changeSet()
		const controller = new AbortController()
		const slow = echoCheck({ args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 10_000 })

		const pending = runCandidateCheck(root, changeSet, slow, 10_000, controller.signal)
		controller.abort()

		await expect(pending).rejects.toThrow()
		expect(createdWorkspaceDirs).toHaveLength(1)
		await expect(lstat(createdWorkspaceDirs[0])).rejects.toMatchObject({ code: "ENOENT" })
	})
})
