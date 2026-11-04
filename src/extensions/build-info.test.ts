import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import {
	classifyVersion,
	createBuildInfoExtension,
	type GitRunner,
	gitFreeEnv,
	KIMCHI_BUILD_ENTRY_TYPE,
	type KimchiBuildEntry,
	type ResolvedBuild,
	readGitState,
	resolveBuildInfo,
	runGit,
} from "./build-info.js"

describe("classifyVersion", () => {
	it.each([
		["dev", { channel: "dev" }],
		["1.27.0", { channel: "release" }],
		["1.28.0-rc.1", { channel: "release" }],
		["0.0.0-canary.20261103.e8dd4fb", { channel: "canary", commit: "e8dd4fb" }],
		["unknown", { channel: "unknown" }],
		["0.0.0-canary.20261103.not-a-sha", { channel: "unknown" }],
	])("%s", (version, expected) => {
		expect(classifyVersion(version)).toEqual(expected)
	})
})

function fakeGit(answers: Record<string, string | Error>): GitRunner {
	return async (args) => {
		const answer = answers[args.join(" ")]
		if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`unexpected git ${args.join(" ")}`)
		return answer
	}
}

describe("readGitState", () => {
	it("reads commit, branch and a clean tree", async () => {
		const git = fakeGit({
			"rev-parse HEAD": "e8dd4fb5aa\n",
			"rev-parse --abbrev-ref HEAD": "master\n",
			"status --porcelain --untracked-files=no": "",
		})
		expect(await readGitState("/repo", git)).toEqual({
			state: { commit: "e8dd4fb5aa", branch: "master", dirty: false },
			complete: true,
		})
	})

	it("reports a dirty tree and omits the branch when HEAD is detached — still complete", async () => {
		const git = fakeGit({
			"rev-parse HEAD": "e8dd4fb5aa\n",
			"rev-parse --abbrev-ref HEAD": "HEAD\n",
			"status --porcelain --untracked-files=no": " M src/cli.ts\n",
		})
		// git ANSWERED `HEAD`: a successful read, not a failure — the answer is complete.
		expect(await readGitState("/repo", git)).toEqual({
			state: { commit: "e8dd4fb5aa", dirty: true },
			complete: true,
		})
	})

	it("marks the answer incomplete when only the branch read fails", async () => {
		const git = fakeGit({
			"rev-parse HEAD": "e8dd4fb5aa\n",
			"status --porcelain --untracked-files=no": "",
		})
		// The failed branch read must not look like a detached HEAD: the answer
		// is partial, so a later session retries the lookup.
		expect(await readGitState("/repo", git)).toEqual({
			state: { commit: "e8dd4fb5aa", dirty: false },
			complete: false,
		})
	})

	it("omits every field git cannot answer", async () => {
		expect(await readGitState("/not-a-repo", fakeGit({}))).toEqual({ state: {}, complete: false })
	})
})

describe("resolveBuildInfo", () => {
	it("does not consult git for a release", async () => {
		const git = vi.fn<GitRunner>()
		expect(await resolveBuildInfo("1.27.0", "/repo", git)).toEqual({
			entry: { schemaVersion: 1, version: "1.27.0", channel: "release" },
			complete: true,
		})
		expect(git).not.toHaveBeenCalled()
	})

	it("takes the commit from a canary version", async () => {
		const git = vi.fn<GitRunner>()
		expect(await resolveBuildInfo("0.0.0-canary.20261103.e8dd4fb", "/repo", git)).toEqual({
			entry: {
				schemaVersion: 1,
				version: "0.0.0-canary.20261103.e8dd4fb",
				channel: "canary",
				commit: "e8dd4fb",
			},
			complete: true,
		})
		expect(git).not.toHaveBeenCalled()
	})

	it("reads the checkout for a dev run", async () => {
		const git = fakeGit({
			"rev-parse HEAD": "e8dd4fb5aa\n",
			"rev-parse --abbrev-ref HEAD": "feat/x\n",
			"status --porcelain --untracked-files=no": "",
		})
		expect(await resolveBuildInfo("dev", "/repo", git)).toEqual({
			entry: {
				schemaVersion: 1,
				version: "dev",
				channel: "dev",
				commit: "e8dd4fb5aa",
				branch: "feat/x",
				dirty: false,
			},
			complete: true,
		})
	})

	it("reports an incomplete dev answer when a branch read fails", async () => {
		const git = fakeGit({
			"rev-parse HEAD": "e8dd4fb5aa\n",
			"status --porcelain --untracked-files=no": "",
		})
		// The entry keeps the fields git answered; the answer is partial, so the
		// extension appends it but retries on the next session_start — a failed
		// branch read is not a detached HEAD.
		expect(await resolveBuildInfo("dev", "/repo", git)).toEqual({
			entry: {
				schemaVersion: 1,
				version: "dev",
				channel: "dev",
				commit: "e8dd4fb5aa",
				dirty: false,
			},
			complete: false,
		})
	})
})

describe("runGit", () => {
	let repo: string
	let other: string
	const savedGitDir = process.env.GIT_DIR
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, env: { ...process.env, GIT_DIR: undefined }, encoding: "utf8" }).trim()

	const init = (prefix: string): string => {
		const dir = mkdtempSync(join(tmpdir(), prefix))
		git(dir, "init", "-q", "-b", "main")
		writeFileSync(join(dir, "file.txt"), "one\n")
		git(dir, "add", "file.txt")
		git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
		return dir
	}

	beforeEach(() => {
		repo = init("kimchi-build-info-")
		other = init("kimchi-build-info-other-")
	})

	afterEach(() => {
		if (savedGitDir === undefined) delete process.env.GIT_DIR
		else process.env.GIT_DIR = savedGitDir
		rmSync(repo, { recursive: true, force: true })
		rmSync(other, { recursive: true, force: true })
	})

	it("ignores every GIT_* variable, not just GIT_DIR", () => {
		expect(
			gitFreeEnv({
				PATH: "/bin",
				GIT_DIR: "a",
				GIT_OBJECT_DIRECTORY: "b",
				GIT_CONFIG: "c",
				GIT_CEILING_DIRECTORIES: "d",
			}),
		).toEqual({ PATH: "/bin" })
	})

	it("reads the checkout when GIT_OBJECT_DIRECTORY points at another repository's objects", async () => {
		process.env.GIT_OBJECT_DIRECTORY = join(other, ".git", "objects")
		try {
			expect(await readGitState(repo, runGit)).toEqual({
				state: {
					commit: git(repo, "rev-parse", "HEAD"),
					branch: "main",
					dirty: false,
				},
				complete: true,
			})
		} finally {
			delete process.env.GIT_OBJECT_DIRECTORY
		}
	})

	it("reads the harness checkout even when GIT_DIR points at another repository", async () => {
		process.env.GIT_DIR = join(other, ".git")
		writeFileSync(join(repo, "file.txt"), "two\n")

		expect(await readGitState(repo, runGit)).toEqual({
			state: {
				commit: git(repo, "rev-parse", "HEAD"),
				branch: "main",
				dirty: true,
			},
			complete: true,
		})
	})
})

describe("build-info extension", () => {
	const entry: KimchiBuildEntry = { schemaVersion: 1, version: "1.27.0", channel: "release" }

	it("records the build on every session start, resolving it once", async () => {
		const resolve = vi.fn(async () => ({ entry, complete: true }))
		const mock = createExtensionApi()
		const extension = createBuildInfoExtension(resolve)
		extension(mock.api)

		await mock.emit("session_start", { reason: "startup" })
		await mock.emit("session_start", { reason: "resume" })
		await extension.settled()

		expect(mock.getAppendedEntries(KIMCHI_BUILD_ENTRY_TYPE)).toEqual([entry, entry])
		expect(resolve).toHaveBeenCalledTimes(1)
	})

	it("does not hold up session_start while the build is being resolved", async () => {
		let finish: (value: ResolvedBuild) => void = () => {}
		const mock = createExtensionApi()
		const extension = createBuildInfoExtension(() => new Promise((resolve) => (finish = resolve)))
		extension(mock.api)

		await mock.emit("session_start", { reason: "startup" })
		expect(mock.getAppendedEntries(KIMCHI_BUILD_ENTRY_TYPE)).toEqual([])

		finish({ entry, complete: true })
		await extension.settled()
		expect(mock.getAppendedEntries(KIMCHI_BUILD_ENTRY_TYPE)).toEqual([entry])
	})

	it("retries on the next session start after a failed resolve", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const resolve = vi
			.fn<() => Promise<ResolvedBuild>>()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue({ entry, complete: true })
		const mock = createExtensionApi()
		const extension = createBuildInfoExtension(resolve)
		extension(mock.api)

		await mock.emit("session_start", { reason: "startup" })
		await extension.settled()
		await mock.emit("session_start", { reason: "new" })
		await extension.settled()

		expect(mock.getAppendedEntries(KIMCHI_BUILD_ENTRY_TYPE)).toEqual([entry])
		expect(resolve).toHaveBeenCalledTimes(2)
		expect(warn).toHaveBeenCalledOnce()
		warn.mockRestore()
	})

	it("drops the entry when the session was replaced while resolving", async () => {
		const warn = vi.spyOn(console, "warn")
		const mock = createExtensionApi()
		const extension = createBuildInfoExtension(async () => {
			mock.invalidate()
			return { entry, complete: true }
		})
		extension(mock.api)

		await mock.emit("session_start", { reason: "startup" })
		await extension.settled()

		expect(mock.getAppendedEntries(KIMCHI_BUILD_ENTRY_TYPE)).toEqual([])
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	it("holds session_shutdown until a pending append settles, so a short-lived session keeps its entry", async () => {
		let finish: (value: ResolvedBuild) => void = () => {}
		const mock = createExtensionApi()
		const extension = createBuildInfoExtension(() => new Promise((resolve) => (finish = resolve)))
		extension(mock.api)

		await mock.emit("session_start", { reason: "startup" })

		// The ACP dispose sequence: session_shutdown is emitted and awaited
		// BEFORE the session is disposed. While git is pending, the emission
		// must not resolve — the handler is holding it.
		let shutdownDone = false
		const shutdown = mock.emit("session_shutdown", { reason: "quit" }).then(() => (shutdownDone = true))
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(shutdownDone).toBe(false)

		finish({ entry, complete: true })
		await shutdown
		// dispose() runs only after the awaited shutdown: the entry landed while the ctx was live.
		expect(mock.getAppendedEntries(KIMCHI_BUILD_ENTRY_TYPE)).toEqual([entry])
	})

	it("appends a partial entry (git failed) but retries git on the next session start", async () => {
		const partial: KimchiBuildEntry = { schemaVersion: 1, version: "dev", channel: "dev" }
		const completeEntry: KimchiBuildEntry = {
			schemaVersion: 1,
			version: "dev",
			channel: "dev",
			commit: "e8dd4fb5aa",
			branch: "feat/x",
			dirty: false,
		}
		const resolve = vi
			.fn<() => Promise<ResolvedBuild>>()
			.mockResolvedValueOnce({ entry: partial, complete: false })
			.mockResolvedValueOnce({ entry: completeEntry, complete: true })
		const mock = createExtensionApi()
		const extension = createBuildInfoExtension(resolve)
		extension(mock.api)

		await mock.emit("session_start", { reason: "startup" })
		await extension.settled()
		await mock.emit("session_start", { reason: "resume" })
		await extension.settled()
		await mock.emit("session_start", { reason: "new" })
		await extension.settled()

		// Partial first, complete after the retry, then the cached complete entry.
		expect(mock.getAppendedEntries(KIMCHI_BUILD_ENTRY_TYPE)).toEqual([partial, completeEntry, completeEntry])
		expect(resolve).toHaveBeenCalledTimes(2)
	})

	it("caches a dev entry whose branch alone is missing (detached HEAD)", async () => {
		const detached: KimchiBuildEntry = {
			schemaVersion: 1,
			version: "dev",
			channel: "dev",
			commit: "e8dd4fb5aa",
			dirty: false,
		}
		const resolve = vi.fn(async () => ({ entry: detached, complete: true }))
		const mock = createExtensionApi()
		const extension = createBuildInfoExtension(resolve)
		extension(mock.api)

		await mock.emit("session_start", { reason: "startup" })
		await extension.settled()
		await mock.emit("session_start", { reason: "new" })
		await extension.settled()

		expect(mock.getAppendedEntries(KIMCHI_BUILD_ENTRY_TYPE)).toEqual([detached, detached])
		expect(resolve).toHaveBeenCalledTimes(1)
	})
})
