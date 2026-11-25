import { execFileSync } from "node:child_process"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseReviewTargetArgs } from "./parser.js"
import { fetchProviderHead, providerReviewMetadata } from "./provider.js"
import { reviewRepositoryCachePath } from "./provider-url.js"
import { resolveReviewTarget } from "./resolve.js"
import type { ProviderReviewRequest } from "./types.js"

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()
}

describe("PR/MR provider resolution", () => {
	let sandbox: string
	let source: string
	let base: string
	let head: string
	let realGit: string
	const url = "https://github.com/owner/repository/pull/42"
	const remote = "https://github.com/owner/repository.git"

	beforeEach(() => {
		realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
		sandbox = mkdtempSync(join(tmpdir(), "review-provider-"))
		source = join(sandbox, "source")
		mkdirSync(source)
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1")
		vi.stubEnv("GIT_CONFIG_GLOBAL", join(sandbox, "global.gitconfig"))
		writeFileSync(
			join(sandbox, "global.gitconfig"),
			`[url "file://${source}"]\n\tinsteadOf = ${remote}\n[protocol "file"]\n\tallow = always\n`,
		)
		git(source, "init", "--initial-branch=main")
		git(source, "config", "user.name", "Review Fixture")
		git(source, "config", "user.email", "review@example.invalid")
		writeFileSync(join(source, "value.txt"), "base\n")
		git(source, "add", "value.txt")
		git(source, "commit", "-m", "base")
		base = git(source, "rev-parse", "HEAD")
		git(source, "checkout", "-b", "feature")
		writeFileSync(join(source, "value.txt"), "feature\n")
		git(source, "commit", "-am", "feature")
		head = git(source, "rev-parse", "HEAD")
		git(source, "update-ref", "refs/pull/42/head", head)
		git(source, "remote", "add", "origin", remote)
		const bin = join(sandbox, "bin")
		mkdirSync(bin)
		const gh = join(bin, "gh")
		const metadata = JSON.stringify({
			headRefName: "feature",
			headRefOid: head,
			baseRefName: "main",
			headRepository: { name: "repository" },
			isCrossRepository: false,
			url,
			title: "Friendly provider review",
		})
		writeFileSync(
			gh,
			[
				"#!/bin/sh",
				'if [ -n "$GH_ARGS" ]; then printf \'%s\' "$3" > "$GH_ARGS"; fi',
				`printf '%s\\n' '${metadata}'`,
				"",
			].join("\n"),
		)
		chmodSync(gh, 0o755)
		vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		rmSync(sandbox, { recursive: true, force: true })
	})

	function request(): ProviderReviewRequest {
		return parseReviewTargetArgs([url]) as ProviderReviewRequest
	}

	it("resolves a same-repository PR through its head and target branch", async () => {
		const target = await resolveReviewTarget(request(), { root: source, contextDir: join(sandbox, "local-context") })
		expect(target.scope.pullRequest).toMatchObject({
			title: "Friendly provider review",
			reportedHeadSha: head,
			headMoved: false,
		})
		expect(target.scope.refs.head).toBe("feature")
		expect(target.scope.pinned.baseSha).toBe(base)
		expect(target.scope.pinned.headSha).toBe(head)
		expect(target.scope.checkoutPath).toBe(realpathSync(source))
		await target.cleanup()
	})

	it("refreshes implicit local and cached target branches, including --fetch, and cleans old siblings", async () => {
		const advanceTarget = async () => {
			git(source, "checkout", "main")
			writeFileSync(join(source, "target.txt"), `${Date.now()}\n`)
			git(source, "add", "target.txt")
			git(source, "commit", "-m", "advance target")
			git(source, "checkout", "feature")
			git(source, "merge", "--no-ff", "main", "-m", "merge target into PR")
			git(source, "update-ref", "refs/pull/42/head", git(source, "rev-parse", "feature"))
			return git(source, "rev-parse", "main")
		}

		const movedTarget = await advanceTarget()
		const local = await resolveReviewTarget(request(), {
			root: source,
			contextDir: join(sandbox, "fresh-local-context"),
		})
		expect(local.scope.pinned.baseSha).toBe(movedTarget)
		await local.cleanup()

		const outside = join(sandbox, "outside")
		mkdirSync(outside)
		const cacheRoot = join(sandbox, "cache")
		const cachePath = reviewRepositoryCachePath(request(), cacheRoot)
		const primed = await resolveReviewTarget(request(), {
			root: outside,
			contextDir: join(sandbox, "primed-cache-context"),
			cacheRoot,
		})
		await primed.cleanup()

		const nextTarget = await advanceTarget()
		const oldClone = `${cachePath}.clone-old`
		const oldInvalid = `${cachePath}.invalid-old`
		const activeClone = `${cachePath}.clone-active`
		const validBackup = `${cachePath}.invalid-backup`
		for (const path of [oldClone, oldInvalid, activeClone]) mkdirSync(path, { recursive: true })
		utimesSync(oldClone, new Date(0), new Date(0))
		utimesSync(oldInvalid, new Date(0), new Date(0))
		git(sandbox, "clone", "--bare", source, validBackup)
		utimesSync(validBackup, new Date(0), new Date(0))
		rmSync(cachePath, { recursive: true, force: true })

		const refreshed = await resolveReviewTarget(
			{ ...request(), fetch: true },
			{ root: outside, contextDir: join(sandbox, "fresh-cache-context"), cacheRoot },
		)
		expect(refreshed.scope.pinned.baseSha).toBe(nextTarget)
		expect(git(cachePath, "rev-parse", "refs/remotes/origin/main")).toBe(nextTarget)
		expect(existsSync(oldClone)).toBe(false)
		expect(existsSync(oldInvalid)).toBe(false)
		expect(existsSync(validBackup)).toBe(false)
		expect(existsSync(activeClone)).toBe(true)
		expect(git(cachePath, "rev-parse", "--is-bare-repository")).toBe("true")
		await refreshed.cleanup()
	})

	it("pins overlapping PR resolutions to different immutable refs and cleans both", async () => {
		let ready!: () => void
		let release!: () => void
		const fetched = new Promise<void>((resolve) => (ready = resolve))
		const resume = new Promise<void>((resolve) => (release = resolve))
		const refs: string[] = []
		const first = resolveReviewTarget(request(), {
			root: source,
			contextDir: join(sandbox, "race-first-context"),
			beforeProviderResolution: async (prepared) => {
				refs.push(prepared.headRef)
				ready()
				await resume
			},
		})
		await fetched
		writeFileSync(join(source, "value.txt"), "moved provider head\n")
		git(source, "commit", "-am", "moved provider head")
		const movedHead = git(source, "rev-parse", "HEAD")
		expect(movedHead).not.toBe(head)
		git(source, "update-ref", "refs/pull/42/head", movedHead)
		const second = await resolveReviewTarget(request(), {
			root: source,
			contextDir: join(sandbox, "race-second-context"),
			beforeProviderResolution: (prepared) => {
				refs.push(prepared.headRef)
			},
		})
		expect(second.scope.pinned.headSha).toBe(movedHead)
		await second.cleanup()
		release()
		const firstTarget = await first
		expect(firstTarget.scope.pinned.headSha).toBe(head)
		expect(new Set(refs).size).toBe(2)
		await firstTarget.cleanup()
		expect(git(source, "for-each-ref", "--format=%(refname)", "refs/kimchi/review/pr-42-")).toBe("")
	})

	it("rebuilds an interrupted cache and reuses its validated clone", async () => {
		const outside = join(sandbox, "outside")
		mkdirSync(outside)
		const cacheRoot = join(sandbox, "cache")
		const cachePath = reviewRepositoryCachePath(request(), cacheRoot)
		mkdirSync(cachePath, { recursive: true })
		writeFileSync(join(cachePath, "HEAD"), "incomplete clone")
		for (const run of ["first", "second"]) {
			const target = await resolveReviewTarget(request(), {
				root: outside,
				contextDir: join(sandbox, `${run}-context`),
				cacheRoot,
			})
			expect(target.scope.pullRequest?.title).toBe("Friendly provider review")
			expect(target.scope.pinned.baseSha).toBe(base)
			expect(target.scope.pinned.headSha).toBe(head)
			expect(target.scope.checkoutPath).not.toBe(source)
			const checkoutPath = target.scope.checkoutPath
			await target.cleanup()
			expect(() => git(outside, "rev-parse", "--show-toplevel")).toThrow()
			expect(() => git(outside, "-C", checkoutPath, "rev-parse", "HEAD")).toThrow()
		}
		expect(git(cachePath, "rev-parse", "--is-bare-repository")).toBe("true")
		expect(
			readdirSync(dirname(cachePath)).filter((entry) => entry.includes(".clone-") || entry.includes(".invalid-")),
		).toEqual([])
	})

	it("cancels metadata and Git fetch without leaking private refs", async () => {
		const metadataAbort = new AbortController()
		const metadataRequest: ProviderReviewRequest = {
			kind: "pull-request",
			url: "https://gitlab.example.test/group/repository/-/merge_requests/7",
			provider: "gitlab",
			host: "gitlab.example.test",
			project: "group/repository",
			number: 7,
			fetch: false,
		}
		let metadataFetchStarted = false
		vi.stubEnv("PATH", join(sandbox, "missing-bin"))
		const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => {
			metadataFetchStarted = true
			return new Promise<Response>((_resolve, reject) => {
				_init?.signal?.addEventListener("abort", () => reject(_init.signal?.reason), { once: true })
			})
		})
		vi.stubGlobal("fetch", fetchMock)
		const metadata = providerReviewMetadata(metadataRequest, metadataAbort.signal)
		await vi.waitFor(() => expect(metadataFetchStarted).toBe(true))
		metadataAbort.abort(new Error("client cancelled metadata lookup"))
		await expect(metadata).rejects.toThrow()
		expect(fetchMock).toHaveBeenCalledOnce()

		const gitAbort = new AbortController()
		const marker = join(sandbox, "fetch-start-marker")
		vi.stubEnv("GIT_PROBE_STARTED", marker)
		const wrapper = join(sandbox, "bin", "git")
		writeFileSync(
			wrapper,
			`#!/bin/sh\ncase "$*" in\n  *fetch*) printf started > "$GIT_PROBE_STARTED"; sleep 10;;\nesac\nexec "${realGit}" "$@"\n`,
		)
		chmodSync(wrapper, 0o755)
		vi.stubEnv("PATH", `${sandbox}/bin:${process.env.PATH ?? ""}`)
		const fetched = fetchProviderHead(
			source,
			"origin",
			request(),
			"refs/kimchi/review/pr-42-cleanup-check",
			gitAbort.signal,
		)
		await vi.waitFor(() => expect(existsSync(marker)).toBe(true))
		gitAbort.abort(new Error("client cancelled Git fetch"))
		await expect(fetched).rejects.toThrow()
		expect(() => git(source, "show-ref", "--verify", "--quiet", "refs/kimchi/review/pr-42-cleanup-check")).toThrow()
	})

	it("falls back when both provider CLIs fail authentication", async () => {
		for (const provider of ["gh", "glab"]) {
			writeFileSync(join(sandbox, "bin", provider), '#!/bin/sh\nprintf "authentication required" >&2\nexit 1\n')
			chmodSync(join(sandbox, "bin", provider), 0o755)
			vi.stubEnv("PATH", `${sandbox}/bin:${process.env.PATH ?? ""}`)
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(
					async () =>
						new Response(
							JSON.stringify({
								head: { ref: "feature", sha: head },
								base: { ref: "main" },
								html_url: provider === "gh" ? url : "https://gitlab.example.test/group/repository/-/merge_requests/7",
								source_branch: "feature",
								sha: head,
								target_branch: "main",
								web_url: "https://gitlab.example.test/group/repository/-/merge_requests/7",
								title: "Fallback title",
							}),
							{ status: 200 },
						),
				),
			)
			const fallbackRequest: ProviderReviewRequest = {
				kind: "pull-request",
				url: provider === "gh" ? url : "https://gitlab.example.test/group/repository/-/merge_requests/7",
				provider: provider === "gh" ? "github" : "gitlab",
				host: provider === "gh" ? "github.com" : "gitlab.example.test",
				project: provider === "gh" ? "owner/repository" : "group/repository",
				number: 7,
				fetch: false,
			}
			await expect(providerReviewMetadata(fallbackRequest)).resolves.toMatchObject({
				headRefName: "feature",
				headRefOid: head,
				title: "Fallback title",
			})
		}
	})

	it("rejects non-auth CLI failures instead of hiding them behind the public fallback", async () => {
		const gh = join(sandbox, "bin", "gh")
		writeFileSync(gh, '#!/bin/sh\nprintf "a transient CLI failure" >&2\nexit 1\n')
		chmodSync(gh, 0o755)
		const fetchMock = vi.fn()
		vi.stubGlobal("fetch", fetchMock)
		await expect(providerReviewMetadata(request())).rejects.toBeInstanceOf(Error)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("bounds public metadata fetching by the provider deadline", async () => {
		vi.stubEnv("PATH", join(sandbox, "missing-bin"))
		vi.useRealTimers()
		try {
			const requestValue: ProviderReviewRequest = {
				kind: "pull-request",
				url: "https://gitlab.example.test/group/repository/-/merge_requests/7",
				provider: "gitlab",
				host: "gitlab.example.test",
				project: "group/repository",
				number: 7,
				fetch: false,
			}
			const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
				})
			})
			vi.stubGlobal("fetch", fetchMock)
			const pending = providerReviewMetadata(requestValue)
			await expect(pending).rejects.toThrow("timed out after 30 seconds")
		} finally {
			vi.useRealTimers()
		}
	}, 35_000)

	it("falls back to unauthenticated public JSON when the provider CLI is missing", async () => {
		vi.stubEnv("PATH", join(sandbox, "missing-bin"))
		const requestValue: ProviderReviewRequest = {
			kind: "pull-request",
			url: "https://gitlab.example.test/group/nested/repository/-/merge_requests/7",
			provider: "gitlab",
			host: "gitlab.example.test",
			project: "group/nested/repository",
			number: 7,
			fetch: false,
		}
		const fetchMock = vi.fn<typeof fetch>(
			async () =>
				new Response(
					JSON.stringify({
						source_branch: "feature",
						sha: head,
						target_branch: "main",
						web_url: requestValue.url,
						title: "Public metadata",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		)
		vi.stubGlobal("fetch", fetchMock)
		await expect(providerReviewMetadata(requestValue)).resolves.toMatchObject({
			headRefName: "feature",
			headRefOid: head,
			baseRefName: "main",
			title: "Public metadata",
		})
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v4/projects/group%2Fnested%2Frepository/")
	})
})
