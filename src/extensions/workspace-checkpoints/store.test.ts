import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CheckpointStore } from "./store.js"

const execFileAsync = promisify(execFile)

let dir: string
let repo: string
let state: string

async function git(...args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd: repo })).stdout.trim()
}

function write(path: string, content: string | Uint8Array): void {
	writeFileSync(join(repo, path), content)
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-checkpoint-store-"))
	repo = join(dir, "work")
	state = join(dir, "state")
	mkdirSync(repo, { recursive: true })
	write("seed.txt", "original\n")
	await git("init", "-q")
	await git("config", "user.name", "Test")
	await git("config", "user.email", "test@local")
	await git("add", "seed.txt")
	await git("commit", "-qm", "baseline")
})

afterEach(() => rmSync(dir, { force: true, recursive: true }))

async function open(sessionId = "session-one"): Promise<CheckpointStore> {
	return CheckpointStore.open({ cwd: repo, stateDir: state, sessionId })
}

describe("CheckpointStore", () => {
	it("captures tracked edits, binary untracked files, and deletions without changing project Git state", async () => {
		const refsBefore = await git("for-each-ref", "--format=%(refname) %(objectname)")
		const indexBefore = await git("diff", "--cached", "--name-only")
		const store = await open()
		await store.capture({ trigger: "session-start" })
		write("seed.txt", "changed\n")
		write("result.bin", new Uint8Array([0, 255, 128, 1, 2]))
		const captured = await store.capture({ trigger: "turn-end", label: "working candidate", validated: true })
		expect(captured.validated).toBe(true)
		expect(captured.includedPathPreview).toContain("result.bin")
		await rmSync(join(repo, "seed.txt"))
		await rmSync(join(repo, "result.bin"))
		const deleted = await store.capture({ trigger: "turn-end" })
		expect(deleted.includedPathCount).toBe(0)
		expect(captured.id).not.toBe(deleted.id)
		expect(store.list()).toHaveLength(3)
		expect(await git("for-each-ref", "--format=%(refname) %(objectname)")).toBe(refsBefore)
		expect(await git("diff", "--cached", "--name-only")).toBe(indexBefore)
	})

	it("deduplicates unchanged automatic captures but keeps explicit validated labels", async () => {
		const store = await open()
		await store.capture({ trigger: "session-start" })
		const unread = await store.capture({ trigger: "turn-end" })
		expect(unread.deduplicatedFrom).toBe(store.checkpointIds[0])
		const second = await store.capture({ trigger: "turn-end" })
		expect(second.deduplicatedFrom).toBe(store.checkpointIds[0])
		const validated = await store.capture({ trigger: "manual", label: "checked", validated: true, deduplicate: false })
		expect(validated.deduplicatedFrom).toBeUndefined()
		expect(validated.id).not.toBe(store.checkpointIds[0])
		expect(store.list()).toHaveLength(2)
	})

	it("returns explicit manifests for excluded or oversized untracked files", async () => {
		write(".env", "secret")
		const large = new Uint8Array(11 * 1024 * 1024)
		write("weights.npy", large)
		const store = await open()
		const capture = await store.capture({ trigger: "session-start" })
		expect(capture.skippedPaths).toEqual(
			expect.arrayContaining([
				{ path: ".env", reason: "credentials" },
				{ path: "weights.npy", reason: "large" },
			]),
		)
	})

	it("restores a chosen candidate after saving the current state and preserves unrelated new files", async () => {
		const store = await open()
		const first = await store.capture({ trigger: "session-start" })
		write("seed.txt", "candidate\n")
		const candidate = await store.capture({ trigger: "manual", label: "verified candidate", validated: true })
		write("seed.txt", "regressed\n")
		write("mine.txt", "keep me\n")
		const regression = await store.capture({ trigger: "turn-end" })
		const restored = await store.restore(candidate.id)
		expect(restored.checkpoint.id).toBe(candidate.id)
		expect(restored.safetyCheckpoint.id).not.toBe(regression.id)
		expect(readFileSync(join(repo, "seed.txt"), "utf8")).toBe("candidate\n")
		expect(readFileSync(join(repo, "mine.txt"), "utf8")).toBe("keep me\n")
		const recovery = await store.restore(restored.safetyCheckpoint.id)
		expect(recovery.restoredPaths).toBeGreaterThan(0)
		expect(readFileSync(join(repo, "seed.txt"), "utf8")).toBe("regressed\n")
		expect(first.id).not.toBe(candidate.id)
	})

	it("rejects cross-branch restoration before files are changed", async () => {
		const store = await open()
		const checkpoint = await store.capture({ trigger: "session-start" })
		await git("switch", "-c", "other")
		write("other.txt", "other\n")
		await expect(store.restore(checkpoint.id)).rejects.toThrow("Cannot restore checkpoint")
		expect(readFileSync(join(repo, "other.txt"), "utf8")).toBe("other\n")
	})

	it("rejects unknown ids", async () => {
		const store = await open()
		await expect(store.restore("missing")).rejects.toThrow("Unknown checkpoint")
	})

	it("coalesces queued automatic captures to the newest tree", async () => {
		const store = await open()
		const first = store.capture({ trigger: "session-start" })
		write("seed.txt", "latest\n")
		const later = await store.capture({ trigger: "turn-end" })
		await first
		expect(store.list().at(-1)?.id).toBe(later.id)
		await store.restore(later.id)
		expect(readFileSync(join(repo, "seed.txt"), "utf8")).toBe("latest\n")
	})

	it("keeps same-workspace session stores isolated during concurrent captures and shutdowns", async () => {
		const one = await open("one")
		const two = await open("two")
		write("one.txt", "one\n")
		const first = one.capture({ trigger: "turn-end" })
		write("two.txt", "two\n")
		const second = two.capture({ trigger: "turn-end" })
		const results = await Promise.all([first, second, one.shutdown(), two.shutdown()])
		expect(results[0]).not.toBe(results[1])
		expect(one.checkpointIds).not.toEqual(two.checkpointIds)
		const oneAgain = await open("one")
		const twoAgain = await open("two")
		expect(oneAgain.checkpointIds).toEqual(one.checkpointIds)
		expect(twoAgain.checkpointIds).toEqual(two.checkpointIds)
	})
})
