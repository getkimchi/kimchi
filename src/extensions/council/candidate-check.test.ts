import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChangeTransaction } from "../../agent-patch/index.js"
import { materializeCandidateWorkspace, runCandidateCheck } from "./candidate-check.js"
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

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "council-candidate-check-"))
	roots.push(root)
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
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("candidate-check", () => {
	it("runs the check against the candidate's content, not the on-disk original", async () => {
		const root = await fixture()
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
		const root = await fixture()
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
		const root = await fixture()
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
		const root = await fixture()
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
		const root = await fixture()
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
		const root = await fixture()
		await writeFile(join(root, "file.txt"), "content\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("file.txt", "candidate\n")
		const changeSet = transaction.changeSet()

		await runCandidateCheck(root, changeSet, echoCheck({ args: ["-e", "process.exit(0)"] }), 5_000)

		expect(createdWorkspaceDirs).toHaveLength(1)
		await expect(lstat(createdWorkspaceDirs[0])).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("removes the temporary workspace when the check exits non-zero", async () => {
		const root = await fixture()
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
		const root = await fixture()
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
