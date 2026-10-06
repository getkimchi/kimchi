import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { getWorkId, setWorkId } from "../work-attribution.js"
import { createWorkCommitTrackingOperations } from "./commits.js"
import { observeToolFiles } from "./file-observations.js"
import { flushWorkSummaries, readWorkRecords } from "./summary.js"

let cwd: string
function git(...args: string[]) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
}
beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-observations-")))
	vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, ".agent"))
	git("init", "-q")
	git("config", "user.name", "Test")
	git("config", "user.email", "test@example.invalid")
	git("config", "commit.gpgSign", "false")
	writeFileSync(join(cwd, ".gitignore"), ".agent/\nignored/\n")
	writeFileSync(join(cwd, "source.ts"), "original\n")
	git("add", ".")
	git("commit", "-qm", "base")
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.unstubAllEnvs()
	rmSync(cwd, { recursive: true, force: true })
})
function observations() {
	return readWorkRecords(join(cwd, ".agent")).filter((row) => row.type === "file_observation")
}

it("compares actual pre-existing dirty content instead of claiming human changes", async () => {
	writeFileSync(join(cwd, "source.ts"), "human version\n")
	const ctx = createContext({ cwd })
	await observeToolFiles(ctx, "read", "bash", async () => "done")
	expect(observations()).toEqual([])
	await observeToolFiles(ctx, "write", "bash", async () => writeFileSync(join(cwd, "new.ts"), "new\n"))
	expect(observations()).toHaveLength(1)
	expect(observations()[0]).toMatchObject({ complete: true, files: [{ path: "new.ts", before: null }] })
})

it("records deletion and a renamed path containing spaces and a newline", async () => {
	await observeToolFiles(createContext({ cwd }), "rename", "bash", async () => {
		renameSync(join(cwd, "source.ts"), join(cwd, "other name\n.ts"))
		git("add", ".")
	})
	expect(observations()[0]).toMatchObject({
		complete: true,
		files: expect.arrayContaining([
			expect.objectContaining({ path: "source.ts", after: null }),
			expect.objectContaining({ path: "other name\n.ts", before: null }),
		]),
	})
})

it("keeps the tool's error after recording writes made before cancellation", async () => {
	const failure = new Error("cancelled")
	const ctx = createContext({ cwd })
	await expect(
		observeToolFiles(
			ctx,
			"cancel",
			"mcp",
			async () => {
				writeFileSync(join(cwd, "source.ts"), "written before cancellation\n")
				throw failure
			},
			{ workId: getWorkId(ctx) },
		),
	).rejects.toBe(failure)
	expect(observations()[0]).toMatchObject({ source: "mcp", complete: true, files: [{ path: "source.ts" }] })
})

it("does not start tracking when MCP runs without an attributed model tool call", async () => {
	await observeToolFiles(createContext({ cwd }), "untracked", "mcp", async () => {
		writeFileSync(join(cwd, "source.ts"), "untracked\n")
	})
	expect(readWorkRecords(join(cwd, ".agent"))).toEqual([])
})

it("reports an incomplete scan instead of treating a truncated dirty tree as complete", async () => {
	for (let i = 0; i < 129; i++) writeFileSync(join(cwd, `${i}.txt`), "dirty\n")
	await observeToolFiles(createContext({ cwd }), "large", "bash", async () => {
		writeFileSync(join(cwd, "source.ts"), "changed\n")
	})
	expect(observations()[0]).toMatchObject({ complete: false, reason: "incomplete-snapshot", files: [] })
})

it("pins a delayed Bash operation to its original work before execution starts", async () => {
	const ctx = createContext({ cwd })
	const original = getWorkId(ctx)
	const operation = createWorkCommitTrackingOperations(ctx, "delayed")
	setWorkId(ctx)
	await operation.exec("printf 'changed\\n' > source.ts", cwd, { onData: () => {} })
	expect(observations()[0]).toMatchObject({ workId: original, toolCallId: "delayed", complete: true })
})

it.each([
	["an untracked symlink", () => symlinkSync("source.ts", join(cwd, "link"))],
	["a dirty file over 8 MiB", () => writeFileSync(join(cwd, "big.log"), Buffer.alloc(8 * 1024 * 1024 + 1, 97))],
	[
		"a nested repository",
		() => {
			mkdirSync(join(cwd, "vendor"))
			execFileSync("git", ["-C", join(cwd, "vendor"), "init", "-q"])
		},
	],
])("observes a read-only Bash call silently in a repository with %s", async (_case, setup) => {
	setup()
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	try {
		await observeToolFiles(createContext({ cwd }), "read-only", "bash", async () => "listing")
		expect(warn).not.toHaveBeenCalled()
	} finally {
		warn.mockRestore()
	}
})
