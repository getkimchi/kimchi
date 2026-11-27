import { execFile } from "node:child_process"
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { WorkspaceGitStore } from "./git-store.js"

const execFileAsync = promisify(execFile)
let dir: string
let repo: string
let shadow: string
let store: WorkspaceGitStore

async function git(args: string[], gitDir = false): Promise<string> {
	const fullArgs = gitDir ? [`--git-dir=${shadow}`, "--work-tree", repo, ...args] : args
	return (await execFileAsync("git", fullArgs, { cwd: repo })).stdout.trim()
}

async function output(path: string): Promise<string> {
	return git(["show", `HEAD:${path}`], true)
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-raw-checkpoint-store-"))
	repo = join(dir, "work")
	shadow = join(dir, "shadow.git")
	mkdirSync(repo, { recursive: true })
	writeFileSync(join(repo, "seed.txt"), "seed\n")
	await git(["init", "-q"])
	await git(["config", "user.name", "Test"])
	await git(["config", "user.email", "test@local"])
	await git(["add", "seed.txt"])
	await git(["commit", "-qm", "baseline"])
	store = await WorkspaceGitStore.open(repo, shadow)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("WorkspaceGitStore", () => {
	it("removes legacy credentials from the next snapshot, not only its preview", async () => {
		writeFileSync(join(repo, ".npmrc"), "//registry.example/:_authToken=legacy")
		const tree = await git(["write-tree"], true)
		const legacyCommit = await git(["commit-tree", tree, "-m", "legacy"], true)
		await git(["update-ref", "HEAD", legacyCommit], true)
		await store.commit({ trigger: "manual", deduplicate: false })
		await expect(output(".npmrc")).rejects.toMatchObject({ code: 128 })
	})

	it("preserves captured symlinks as symlinks on restore", async () => {
		writeFileSync(join(repo, "target.txt"), "target")
		symlinkSync("target.txt", join(repo, "link.txt"))
		const candidate = await store.commit({ trigger: "candidate", deduplicate: false })
		rmSync(join(repo, "link.txt"))
		await store.commit({ trigger: "turn-end" })
		await store.restore(candidate.id)
		expect(readFileSync(join(repo, "link.txt"), "utf8")).toBe("target")
		expect(readFileSync(join(repo, "target.txt"), "utf8")).toBe("target")
	})

	it("restores a candidate-created file even when currently absent", async () => {
		writeFileSync(join(repo, "new.txt"), "new")
		const candidate = await store.commit({ trigger: "candidate", deduplicate: false })
		rmSync(join(repo, "new.txt"))
		await store.commit({ trigger: "turn-end" })
		await store.restore(candidate.id)
		expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("new")
	})

	it("preflights unsafe symlinks before changing any restore target", async () => {
		writeFileSync(join(repo, "alpha.txt"), "candidate-a")
		writeFileSync(join(repo, "zeta.txt"), "candidate-z")
		const candidate = await store.commit({ trigger: "candidate", deduplicate: false })
		writeFileSync(join(repo, "alpha.txt"), "current-a")
		rmSync(join(repo, "zeta.txt"))
		writeFileSync(join(repo, "outside.txt"), "outside")
		symlinkSync("outside.txt", join(repo, "zeta.txt"))
		await store.commit({ trigger: "turn-end" })
		await expect(store.restore(candidate.id)).rejects.toThrow("symlink")
		expect(readFileSync(join(repo, "alpha.txt"), "utf8")).toBe("current-a")
	})

	it("recreates missing parent directories while restoring a candidate", async () => {
		mkdirSync(join(repo, "new", "parents"), { recursive: true })
		writeFileSync(join(repo, "new", "parents", "result.txt"), "nested")
		const candidate = await store.commit({ trigger: "candidate", deduplicate: false })
		rmSync(join(repo, "new"), { recursive: true, force: true })
		await store.commit({ trigger: "turn-end" })
		await store.restore(candidate.id)
		expect(readFileSync(join(repo, "new", "parents", "result.txt"), "utf8")).toBe("nested")
	})

	it("honors a pre-aborted restore without changing any files", async () => {
		const candidate = await store.commit({ trigger: "candidate", deduplicate: false })
		writeFileSync(join(repo, "seed.txt"), "current\n")
		await store.commit({ trigger: "turn-end" })
		const signal = AbortSignal.abort()
		await expect(store.restore(candidate.id, signal)).rejects.toMatchObject({ name: "AbortError" })
		expect(readFileSync(join(repo, "seed.txt"), "utf8")).toBe("current\n")
	})

	it("captures executable-bit changes after an unchanged-turn optimization", async () => {
		const script = join(repo, "run.sh")
		writeFileSync(script, "#!/bin/sh\necho ok\n")
		chmodSync(script, 0o644)
		const first = await store.commit({ trigger: "candidate" })
		chmodSync(script, 0o755)
		const second = await store.commit({ trigger: "turn-end" })
		expect(second.id).not.toBe(first.id)
		expect(await git(["ls-tree", second.treeSha, "--", "run.sh"], true)).toMatch(/^100755 /)
	})

	it("captures same-size edits even when mtime is restored", async () => {
		const target = join(repo, "data.txt")
		writeFileSync(target, "one\n")
		utimesSync(target, 1_700_000_000, 1_700_000_000)
		const first = await store.commit({ trigger: "candidate" })
		writeFileSync(target, "two\n")
		utimesSync(target, 1_700_000_000, 1_700_000_000)
		expect(statSync(target).mtimeMs).toBe(1_700_000_000_000)
		const second = await store.commit({ trigger: "turn-end" })
		expect(second.id).not.toBe(first.id)
		expect(await git(["show", `${second.treeSha}:data.txt`], true)).toBe("two")
	})

	it("reuses an unchanged commit without rewriting refs or the private index", async () => {
		const first = await store.commit({ trigger: "session-start" })
		const indexMtime = statSync(join(shadow, "index")).mtimeMs
		const second = await store.commit({ trigger: "turn-end" })
		expect(second.id).toBe(first.id)
		expect(second.unchanged).toBe(true)
		expect(second.deduplicatedFrom).toBe(first.id)
		expect(statSync(join(shadow, "index")).mtimeMs).toBe(indexMtime)

		utimesSync(join(repo, "seed.txt"), 1_700_000_000, 1_700_000_000)
		const deduplicated = await store.commit({ trigger: "turn-end" })
		expect(deduplicated.id).toBe(first.id)
		const afterTreeDedup = statSync(join(shadow, "index")).mtimeMs
		await store.commit({ trigger: "turn-end" })
		expect(statSync(join(shadow, "index")).mtimeMs).toBe(afterTreeDedup)
	})
})
