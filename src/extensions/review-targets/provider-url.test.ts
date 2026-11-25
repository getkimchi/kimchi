import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { acquireReviewRepositoryLock } from "./provider.js"
import { parseProviderReviewUrl, reviewRepositoryCachePath, sanitizeReviewDisplayText } from "./provider-url.js"

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("provider review URLs", () => {
	it("parses GitHub pull requests", () => {
		expect(parseProviderReviewUrl("https://github.com/owner/repository/pull/42")).toMatchObject({
			provider: "github",
			host: "github.com",
			project: "owner/repository",
			number: 42,
		})
	})

	it("drops token-bearing queries and fragments from canonical URLs", () => {
		const github = parseProviderReviewUrl("https://github.com/owner/repository/pull/42?private_token=dummy")
		expect(github?.url).toBe("https://github.com/owner/repository/pull/42")
		const gitlab = parseProviderReviewUrl(
			"https://gitlab.example.test/group/nested/repository/-/merge_requests/19?private_token=dummy",
		)
		expect(gitlab?.url).toBe("https://gitlab.example.test/group/nested/repository/-/merge_requests/19")
	})

	it("parses nested GitLab groups and self-hosted hosts", () => {
		expect(
			parseProviderReviewUrl("https://gitlab.example.test:8443/group/subgroup/repository/-/merge_requests/19"),
		).toMatchObject({
			provider: "gitlab",
			host: "gitlab.example.test:8443",
			project: "group/subgroup/repository",
			number: 19,
		})
	})

	it.each([
		"http://github.com/owner/repository/pull/42",
		"https://github.com/owner/repository/issues/42",
		"https://github.com/owner/repository/pull/0",
		"https://gitlab.example.test/group/project/merge_requests/4",
		"https://gitlab.example.test/-/merge_requests/4",
		"https://user@github.com/owner/repository/pull/42",
		"not a URL",
	])("rejects invalid provider URL %s", (value) => {
		expect(parseProviderReviewUrl(value)).toBeUndefined()
	})
})

describe("provider presentation sanitization", () => {
	it("strips ANSI, OSC, and C0/C1 controls and collapses whitespace", () => {
		expect(sanitizeReviewDisplayText("unsafe\u001b[31m title \u001b]0;script\u0007\r\ncontinuation\u001b[0m")).toBe(
			"unsafe title continuation",
		)
	})
})

describe("provider repository cache", () => {
	const quickRetries = {
		retries: 100,
		factor: 1,
		minTimeout: 5,
		maxTimeout: 5,
		maxRetryTime: 2_000,
		unref: true,
	} as const

	async function expectConcurrentOwner(cachePath: string, count: number): Promise<void> {
		const controllers = Array.from({ length: count }, () => new AbortController())
		let completed = 0
		const attempts = controllers.map((controller) =>
			acquireReviewRepositoryLock(cachePath, {
				signal: controller.signal,
				onCompromised: (error) => controller.abort(error),
				retries: quickRetries,
			}).then((release) => {
				completed += 1
				return release
			}),
		)
		const release = await Promise.race(attempts)
		expect(completed).toBe(1)
		for (const controller of controllers) controller.abort(new Error("Stop waiting test acquirer"))
		await release()
		const results = await Promise.allSettled(attempts)
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(count - 1)
		for (const result of results) {
			if (result.status === "rejected") {
				expect(["Stop waiting test acquirer", "repository_cache_compromised"]).toContain(
					typeof result.reason === "object" && result.reason !== null && "code" in result.reason
						? result.reason.code
						: result.reason.message,
				)
			}
		}
		const next = await acquireReviewRepositoryLock(cachePath, { retries: quickRetries })
		await next()
	}

	it("derives a host and nested-project cache path", () => {
		expect(
			reviewRepositoryCachePath(
				{ host: "gitlab.example.test", project: "group/nested/repository" },
				"/cache/review-repos",
			),
		).toBe(join("/cache/review-repos", "gitlab.example.test", "group", "nested", "repository.git"))
	})

	it("keeps one concurrent acquirer from a stale directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-cache-race-lock-"))
		temporaryDirectories.push(root)
		const cachePath = join(root, "host", "owner", "repository.git")
		mkdirSync(`${cachePath}.lock`, { recursive: true })
		utimesSync(`${cachePath}.lock`, new Date(0), new Date(0))
		await expectConcurrentOwner(cachePath, 20)
	})

	it("keeps one acquirer among 24 concurrent first-time contenders", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-cache-fresh-race-lock-"))
		temporaryDirectories.push(root)
		await expectConcurrentOwner(join(root, "host", "owner", "repository.git"), 24)
	})

	it("waits for a fresh contender and acquires it after release", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-cache-wait-lock-"))
		temporaryDirectories.push(root)
		const cachePath = join(root, "host", "owner", "repository.git")
		const firstRelease = await acquireReviewRepositoryLock(cachePath, { retries: quickRetries })
		let waitingSettled = false
		const waiting = acquireReviewRepositoryLock(cachePath, { retries: quickRetries })
		void waiting.then(
			() => {
				waitingSettled = true
			},
			() => {
				waitingSettled = true
			},
		)
		await delay(30)
		expect(waitingSettled).toBe(false)
		await firstRelease()
		const secondRelease = await waiting
		await secondRelease()
	})

	it("aborts a contender waiting for a fresh owner and releases late acquisitions", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-cache-abort-lock-"))
		temporaryDirectories.push(root)
		const cachePath = join(root, "host", "owner", "repository.git")
		const firstRelease = await acquireReviewRepositoryLock(cachePath, { retries: quickRetries })
		const controller = new AbortController()
		const pending = acquireReviewRepositoryLock(cachePath, { signal: controller.signal, retries: quickRetries })
		await delay(25)
		controller.abort(new Error("Cache wait was cancelled"))
		await expect(pending).rejects.toThrow("Cache wait was cancelled")
		await firstRelease()
		await delay(25)
		const next = await acquireReviewRepositoryLock(cachePath, { retries: quickRetries })
		await next()
	})

	it("takes over an old lock directory whose creating process has exited", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-cache-stale-lock-"))
		temporaryDirectories.push(root)
		const cachePath = join(root, "host", "owner", "repository.git")
		const lockPath = `${cachePath}.lock`
		const owner = spawnSync(
			process.execPath,
			["-e", "require('node:fs').mkdirSync(process.env.REVIEW_LOCK_PATH, { recursive: true })"],
			{
				env: { ...process.env, REVIEW_LOCK_PATH: lockPath },
			},
		)
		expect(owner.status).toBe(0)
		utimesSync(lockPath, new Date(0), new Date(0))
		const release = await acquireReviewRepositoryLock(cachePath, { retries: quickRetries })
		expect(existsSync(lockPath)).toBe(true)
		await release()
	})

	it("aborts an owner on compromise and tolerates the compromised release", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-cache-compromised-lock-"))
		temporaryDirectories.push(root)
		const cachePath = join(root, "host", "owner", "repository.git")
		const controller = new AbortController()
		const compromised = vi.fn((error: unknown) => controller.abort(error))
		const release = await acquireReviewRepositoryLock(cachePath, {
			signal: controller.signal,
			onCompromised: compromised,
			stale: 4_000,
			update: 25,
			retries: quickRetries,
		})
		rmSync(`${cachePath}.lock`, { recursive: true, force: true })
		await vi.waitFor(() => expect(controller.signal.aborted).toBe(true), { timeout: 2_500 })
		expect(compromised).toHaveBeenCalledOnce()
		expect(controller.signal.reason).toMatchObject({ code: "repository_cache_compromised" })
		await expect(release()).resolves.toBeUndefined()
	})

	it("releases a just-created lock when initialization fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-cache-init-failure-"))
		temporaryDirectories.push(root)
		const cachePath = join(root, "host", "owner", "repository.git")
		const lockPath = `${cachePath}.lock`
		await expect(
			acquireReviewRepositoryLock(cachePath, {
				beforeWrite: async () => {
					throw new Error("injected write failure")
				},
			}),
		).rejects.toThrow("injected write failure")
		expect(existsSync(lockPath)).toBe(false)
		const release = await acquireReviewRepositoryLock(cachePath)
		await release()
	})
})
