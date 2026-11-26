import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { type LockOptions, lock } from "proper-lockfile"
import { errorMessage, gitText, optionalCommit, repositoryRoot } from "./git.js"
import { parseProviderReviewUrl, reviewRepositoryCachePath, sanitizeReviewDisplayText } from "./provider-url.js"
import type { ProviderReviewRequest, ResolveReviewTargetOptions } from "./types.js"
import { ReviewTargetError } from "./types.js"

const execFileAsync = promisify(execFile)
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const PROVIDER_TIMEOUT_MS = 30_000

export interface ProviderReviewMetadata {
	headRefName: string
	headRefOid: string
	baseRefName: string
	url: string
	title: string
}

export interface PreparedProviderReview {
	root: string
	remote: string
	headRef: string
	headRefName: string
	baseRefName: string
	headSha: string
	metadata: ProviderReviewMetadata
	cleanup: () => Promise<void>
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requiredString(value: Record<string, unknown>, key: string): string {
	const result = value[key]
	if (typeof result !== "string" || !result.trim()) {
		throw new ReviewTargetError("provider_metadata", `Provider metadata has no usable ${key}.`)
	}
	return result
}

function validHead(value: string): string {
	if (!OBJECT_ID.test(value)) {
		throw new ReviewTargetError(
			"provider_metadata",
			"Provider metadata did not report a full lowercase head commit ID.",
		)
	}
	return value
}

function unusableCliAuthentication(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return /not logged in|login required|authentication required|requires authentication|unauthorized|invalid credentials|no credentials|oauth|401/i.test(
		message,
	)
}

function missingCli(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

function canonicalMetadataUrl(value: unknown, request: ProviderReviewRequest): string {
	const parsed = typeof value === "string" ? parseProviderReviewUrl(value) : undefined
	return parsed &&
		parsed.provider === request.provider &&
		parsed.host === request.host &&
		parsed.project === request.project &&
		parsed.number === request.number
		? parsed.url
		: request.url
}

async function publicJson(url: string, signal?: AbortSignal): Promise<unknown> {
	const deadline = AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
	const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
	try {
		const response = await fetch(url, { headers: { accept: "application/json" }, signal: requestSignal })
		if (!response.ok) {
			throw new ReviewTargetError(
				"provider_metadata",
				`Public provider metadata request returned HTTP ${response.status}.`,
			)
		}
		return await response.json()
	} catch (error) {
		if (deadline.aborted && !signal?.aborted) {
			throw new ReviewTargetError(
				"provider_metadata",
				`Public provider metadata request timed out after ${PROVIDER_TIMEOUT_MS / 1000} seconds.`,
			)
		}
		if (error instanceof ReviewTargetError) throw error
		throw new ReviewTargetError("provider_metadata", `Could not read public provider metadata: ${errorMessage(error)}`)
	}
}

async function githubMetadata(request: ProviderReviewRequest, signal?: AbortSignal): Promise<ProviderReviewMetadata> {
	try {
		const { stdout } = await execFileAsync(
			"gh",
			[
				"pr",
				"view",
				request.url,
				"--json",
				"headRefName,headRefOid,baseRefName,headRepository,isCrossRepository,url,title",
			],
			{ timeout: PROVIDER_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf8", signal },
		)
		const value = JSON.parse(stdout) as unknown
		if (!object(value)) throw new Error("metadata is not an object")
		return {
			headRefName: requiredString(value, "headRefName"),
			headRefOid: validHead(requiredString(value, "headRefOid")),
			baseRefName: requiredString(value, "baseRefName"),
			url: canonicalMetadataUrl(value.url, request),
			title: sanitizeReviewDisplayText(requiredString(value, "title")),
		}
	} catch (error) {
		if (!missingCli(error) && !unusableCliAuthentication(error)) {
			if (error instanceof ReviewTargetError) throw error
			throw new ReviewTargetError("provider_metadata", "Could not read GitHub pull-request metadata with gh.")
		}
	}
	const value = await publicJson(
		`https://api.github.com/repos/${request.project.split("/").map(encodeURIComponent).join("/")}/pulls/${request.number}`,
		signal,
	)
	if (!object(value) || !object(value.head) || !object(value.base)) {
		throw new ReviewTargetError("provider_metadata", "GitHub public metadata has an unexpected shape.")
	}
	return {
		headRefName: requiredString(value.head, "ref"),
		headRefOid: validHead(requiredString(value.head, "sha")),
		baseRefName: requiredString(value.base, "ref"),
		url: canonicalMetadataUrl(value.html_url, request),
		title: sanitizeReviewDisplayText(requiredString(value, "title")),
	}
}

async function gitlabMetadata(request: ProviderReviewRequest, signal?: AbortSignal): Promise<ProviderReviewMetadata> {
	try {
		const { stdout } = await execFileAsync(
			"glab",
			["mr", "view", String(request.number), "-R", request.project, "-F", "json"],
			{
				timeout: PROVIDER_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
				encoding: "utf8",
				signal,
				env: { ...process.env, GITLAB_HOST: request.host, GIT_TERMINAL_PROMPT: "0" },
			},
		)
		const value = JSON.parse(stdout) as unknown
		if (!object(value)) throw new Error("metadata is not an object")
		return {
			headRefName: requiredString(value, "source_branch"),
			headRefOid: validHead(requiredString(value, "sha")),
			baseRefName: requiredString(value, "target_branch"),
			url: canonicalMetadataUrl(value.web_url, request),
			title: sanitizeReviewDisplayText(requiredString(value, "title")),
		}
	} catch (error) {
		if (!missingCli(error) && !unusableCliAuthentication(error)) {
			if (error instanceof ReviewTargetError) throw error
			throw new ReviewTargetError("provider_metadata", "Could not read GitLab merge-request metadata with glab.")
		}
	}
	const value = await publicJson(
		`https://${request.host}/api/v4/projects/${encodeURIComponent(request.project)}/merge_requests/${request.number}`,
		signal,
	)
	if (!object(value))
		throw new ReviewTargetError("provider_metadata", "GitLab public metadata has an unexpected shape.")
	return {
		headRefName: requiredString(value, "source_branch"),
		headRefOid: validHead(requiredString(value, "sha")),
		baseRefName: requiredString(value, "target_branch"),
		url: canonicalMetadataUrl(value.web_url, request),
		title: sanitizeReviewDisplayText(requiredString(value, "title")),
	}
}

export function providerReviewMetadata(
	request: ProviderReviewRequest,
	signal?: AbortSignal,
): Promise<ProviderReviewMetadata> {
	return request.provider === "github" ? githubMetadata(request, signal) : gitlabMetadata(request, signal)
}

function normalizedRemote(value: string): { host: string; project: string } | undefined {
	try {
		if (/^[^/@:]+@[^/:]+:.+$/.test(value)) {
			const separator = value.indexOf(":")
			const host = value.slice(value.indexOf("@") + 1, separator).toLowerCase()
			return { host, project: value.slice(separator + 1).replace(/^\/+|\.git$/g, "") }
		}
		const url = new URL(value)
		return { host: url.host.toLowerCase(), project: decodeURIComponent(url.pathname).replace(/^\/+|\.git$/g, "") }
	} catch {
		return undefined
	}
}

async function matchingLocalRemote(
	root: string,
	request: ProviderReviewRequest,
	configured: string | undefined,
	signal?: AbortSignal,
): Promise<string | undefined> {
	let remotes: string[]
	try {
		remotes = (await gitText(root, ["remote"], { signal })).split("\n").filter(Boolean)
	} catch {
		return undefined
	}
	const names = configured ? remotes.filter((remote) => remote === configured) : remotes
	for (const remote of names) {
		let url: string
		try {
			// remote get-url applies insteadOf rewrites; the configured spelling
			// identifies the provider even when traffic is redirected to a mirror.
			url = await gitText(root, ["config", "--get", `remote.${remote}.url`], { signal })
		} catch {
			continue
		}
		const normalized = normalizedRemote(url.trim())
		if (normalized?.host.toLowerCase() === request.host.toLowerCase() && normalized.project === request.project)
			return remote
	}
	return undefined
}

const REPOSITORY_CACHE_ORPHAN_STALE_MS = 60_000
const REPOSITORY_CACHE_LOCK_STALE_MS = 10 * 60_000
const REPOSITORY_CACHE_LOCK_WAIT_MS = 120_000
const REPOSITORY_CACHE_LOCK_RETRY_OPTIONS: LockOptions["retries"] = {
	retries: 119,
	factor: 1,
	minTimeout: 1_000,
	maxTimeout: 1_000,
	maxRetryTime: REPOSITORY_CACHE_LOCK_WAIT_MS,
	unref: true,
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

interface ReviewRepositoryLockOptions {
	signal?: AbortSignal
	onCompromised?: (error: ReviewTargetError) => void
	/** @internal Test cleanup following a write failure after lock acquisition. */
	beforeWrite?: () => void | Promise<void>
	/** @internal Test-only override for checking stale takeover quickly. */
	stale?: number
	/** @internal Test-only override for checking compromise quickly. */
	update?: number
	/** @internal Test-only override that avoids a two-minute wait. */
	retries?: LockOptions["retries"]
}

async function waitForCacheLock(
	acquisition: Promise<() => Promise<void>>,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	if (!signal) return acquisition
	signal.throwIfAborted()
	const abort = () =>
		rejectWaiting(
			signal.reason instanceof Error
				? signal.reason
				: new Error("Review was cancelled while waiting for its repository cache lock."),
		)
	let rejectWaiting!: (error: Error) => void
	const cancelled = new Promise<never>((_resolve, reject) => {
		rejectWaiting = reject
		signal.addEventListener("abort", abort, { once: true })
	})
	try {
		return await Promise.race([acquisition, cancelled])
	} finally {
		signal.removeEventListener("abort", abort)
	}
}

export async function acquireReviewRepositoryLock(
	cachePath: string,
	options: ReviewRepositoryLockOptions = {},
): Promise<() => Promise<void>> {
	options.signal?.throwIfAborted()
	await mkdir(dirname(cachePath), { recursive: true })
	const stale = options.stale ?? REPOSITORY_CACHE_LOCK_STALE_MS
	let compromised = false
	let releaseOwnedLock: (() => Promise<void>) | undefined
	const acquisition = lock(cachePath, {
		stale,
		update: options.update ?? Math.floor(stale / 2),
		retries: options.retries ?? REPOSITORY_CACHE_LOCK_RETRY_OPTIONS,
		realpath: false,
		onCompromised: (error) => {
			compromised = true
			const failure = new ReviewTargetError(
				"repository_cache_compromised",
				`Repository cache lock was compromised for ${cachePath}. Review cancelled to prevent concurrent cache access. ${errorMessage(error)}`,
			)
			if (options.onCompromised) options.onCompromised(failure)
			else throw failure
		},
	}).catch((error: unknown) => {
		if (
			(error as NodeJS.ErrnoException).code === "ELOCKED" ||
			(error instanceof Error && error.message === "RetryOperation timeout occurred")
		) {
			throw new ReviewTargetError(
				"repository_cache_locked",
				`The review repository cache lock remained busy for about two minutes: ${cachePath}.lock. Retry after the other review finishes.`,
			)
		}
		throw error
	})
	try {
		const acquiredRelease = await waitForCacheLock(acquisition, options.signal)
		const release = async () => {
			try {
				await acquiredRelease()
			} catch (error) {
				if (!(compromised && (error as NodeJS.ErrnoException).code === "ERELEASED")) throw error
			}
		}
		releaseOwnedLock = release
		if (options.signal?.aborted) {
			await release()
			options.signal.throwIfAborted()
		}
		await options.beforeWrite?.()
		return release
	} catch (error) {
		if (options.signal?.aborted) {
			// proper-lockfile has no abort option. It retries on an unref'd timer;
			// release it if this abandoned acquisition eventually succeeds.
			void acquisition.then((lateRelease) => lateRelease()).catch(() => {})
			options.signal.throwIfAborted()
		}
		if (releaseOwnedLock) await releaseOwnedLock()
		throw error
	}
}

function publicCloneUrl(request: ProviderReviewRequest): string {
	return `https://${request.host}/${request.project.split("/").map(encodeURIComponent).join("/")}.git`
}

async function janitorRepositoryCache(cachePath: string, signal?: AbortSignal): Promise<void> {
	const basename = cachePath.slice(cachePath.lastIndexOf("/") + 1)
	const candidates: Array<{ path: string; age: number; backup: boolean }> = []
	let names: string[]
	try {
		names = await readdir(dirname(cachePath))
	} catch {
		return
	}
	for (const name of names) {
		const backup = name.startsWith(`${basename}.invalid-`)
		if (!backup && !name.startsWith(`${basename}.clone-`)) continue
		const path = join(dirname(cachePath), name)
		try {
			const metadata = await lstat(path)
			const age = Date.now() - metadata.mtimeMs
			if (age >= REPOSITORY_CACHE_ORPHAN_STALE_MS) candidates.push({ path, age, backup })
		} catch {
			// A sibling may already have been collected.
		}
	}
	candidates.sort((left, right) => right.age - left.age)
	if (!(await pathExists(cachePath))) {
		for (const candidate of candidates) {
			if (!candidate.backup) continue
			if (!(await validBareCache(candidate.path, signal))) continue
			await rename(candidate.path, cachePath).catch(() => {})
			break
		}
	}
	for (const candidate of candidates) {
		if (candidate.path === cachePath) continue
		await rm(candidate.path, { recursive: true, force: true }).catch(() => {})
	}
}

async function validBareCache(cachePath: string, signal?: AbortSignal): Promise<boolean> {
	if (!(await pathExists(cachePath))) return false
	try {
		const bare = (await gitText(cachePath, ["rev-parse", "--is-bare-repository"], { signal })).trim()
		if (bare !== "true") return false
		await gitText(cachePath, ["config", "--get", "remote.origin.url"], { signal })
		return (await optionalCommit(cachePath, "HEAD", signal)) !== undefined
	} catch {
		return false
	}
}

async function cloneIntoCacheAtomically(
	request: ProviderReviewRequest,
	options: ResolveReviewTargetOptions,
	cachePath: string,
): Promise<void> {
	const suffix = `${process.pid}-${randomUUID()}`
	const stagingPath = `${cachePath}.clone-${suffix}`
	const backupPath = `${cachePath}.invalid-${suffix}`
	let backedUp = false
	let installed = false
	try {
		await gitText(options.root, ["clone", "--bare", "--filter=blob:none", publicCloneUrl(request), stagingPath], {
			signal: options.signal,
			lazyFetch: true,
		})
		if (!(await validBareCache(stagingPath, options.signal))) throw new Error("Incomplete clone")
		if (await pathExists(cachePath)) {
			await rename(cachePath, backupPath)
			backedUp = true
		}
		await rename(stagingPath, cachePath)
		installed = true
	} catch {
		if (backedUp && !installed) await rename(backupPath, cachePath).catch(() => {})
		throw new ReviewTargetError(
			"repository_cache_clone",
			`Could not clone the public review repository ${request.host}/${request.project} into the Kimchi cache.`,
		)
	} finally {
		await rm(stagingPath, { recursive: true, force: true }).catch(() => {})
		if (installed) await rm(backupPath, { recursive: true, force: true }).catch(() => {})
	}
}

async function cachedBareRepository(
	request: ProviderReviewRequest,
	options: ResolveReviewTargetOptions,
): Promise<string> {
	const cacheRoot = options.cacheRoot ?? join(homedir(), ".kimchi", "review-repos")
	const cachePath = reviewRepositoryCachePath(request, cacheRoot)
	const release = await acquireReviewRepositoryLock(cachePath, {
		signal: options.signal,
		onCompromised: options.onCacheCompromised,
	})
	try {
		await janitorRepositoryCache(cachePath, options.signal)
		if (await validBareCache(cachePath, options.signal)) {
			try {
				await gitText(
					cachePath,
					["fetch", "--no-tags", "--no-recurse-submodules", "origin", "+refs/heads/*:refs/remotes/origin/*"],
					{
						signal: options.signal,
						lazyFetch: true,
					},
				)
				return cachePath
			} catch {
				throw new ReviewTargetError(
					"repository_cache_fetch",
					`Could not update the cached review repository for ${request.host}/${request.project}.`,
				)
			}
		}
		await cloneIntoCacheAtomically(request, options, cachePath)
		return cachePath
	} catch (error) {
		options.signal?.throwIfAborted()
		throw error
	} finally {
		await release()
	}
}

function privateHeadRef(request: ProviderReviewRequest): string {
	return `refs/kimchi/review/${request.provider === "github" ? "pr" : "mr"}-${request.number}-${randomUUID()}`
}

export async function fetchProviderHead(
	root: string,
	remote: string,
	request: ProviderReviewRequest,
	ref: string,
	signal?: AbortSignal,
): Promise<string> {
	const source = request.provider === "github" ? `pull/${request.number}/head` : `merge-requests/${request.number}/head`
	try {
		await gitText(root, ["fetch", "--no-tags", "--no-recurse-submodules", remote, `+${source}:${ref}`], {
			signal,
			lazyFetch: true,
		})
		const sha = await optionalCommit(root, ref, signal)
		if (!sha) throw new ReviewTargetError("provider_head_fetch", "The fetched provider head is not a commit.")
		return sha
	} catch (error) {
		await gitText(root, ["update-ref", "-d", ref], { signal: AbortSignal.timeout(30_000) }).catch(() => {})
		if (error instanceof ReviewTargetError) throw error
		throw new ReviewTargetError(
			"provider_head_fetch",
			`Could not fetch ${request.provider === "github" ? "pull request" : "merge request"} ${request.number} for ${request.host}/${request.project}.`,
		)
	}
}

async function ensureProviderBase(
	root: string,
	remote: string,
	baseRefName: string,
	request: ProviderReviewRequest,
	signal?: AbortSignal,
): Promise<void> {
	if (request.base !== undefined) return
	// The implicit PR/MR base must name the provider's current target branch.
	// Refresh it even when a local or remote-tracking ref already exists.
	try {
		await gitText(
			root,
			[
				"fetch",
				"--no-tags",
				"--no-recurse-submodules",
				remote,
				`+refs/heads/${baseRefName}:refs/remotes/${remote}/${baseRefName}`,
			],
			{ signal, lazyFetch: true },
		)
	} catch {
		throw new ReviewTargetError(
			"provider_base_fetch",
			`Could not fetch the provider target branch ${baseRefName} for ${request.host}/${request.project}.`,
		)
	}
}

async function removeProviderWorktree(cachePath: string, worktreePath: string): Promise<void> {
	try {
		await gitText(cachePath, ["worktree", "remove", "--force", worktreePath], {
			signal: AbortSignal.timeout(30_000),
			lazyFetch: true,
		})
	} finally {
		await rm(worktreePath, { recursive: true, force: true }).catch(() => {})
	}
}

export async function prepareProviderReview(
	request: ProviderReviewRequest,
	options: ResolveReviewTargetOptions,
): Promise<PreparedProviderReview> {
	const metadata = await providerReviewMetadata(request, options.signal)
	let localRoot: string | undefined
	try {
		localRoot = await repositoryRoot(options.root, options.signal)
	} catch {
		options.signal?.throwIfAborted()
		// An explicit provider URL is allowed outside any checkout.
	}
	const localRemote = localRoot
		? await matchingLocalRemote(localRoot, request, options.remote, options.signal)
		: undefined
	const cached = !localRoot || !localRemote
	const root = cached ? await cachedBareRepository(request, options) : localRoot
	const remote = cached ? "origin" : localRemote
	if (!root || !remote) throw new ReviewTargetError("provider_repository", "Could not select a provider repository.")
	const headRef = privateHeadRef(request)
	let headSha: string | undefined
	let worktreePath: string | undefined
	let worktreeParent: string | undefined
	let cleanupPromise: Promise<void> | undefined
	const cleanup = () => {
		cleanupPromise ??= (async () => {
			try {
				if (cached && worktreePath) await removeProviderWorktree(root, worktreePath)
			} finally {
				if (worktreeParent) await rm(worktreeParent, { recursive: true, force: true }).catch(() => {})
				// Expected-SHA deletion makes cleanup unable to remove another resolution's ref.
				await gitText(root, headSha ? ["update-ref", "-d", headRef, headSha] : ["update-ref", "-d", headRef], {
					signal: AbortSignal.timeout(30_000),
				})
			}
		})()
		return cleanupPromise
	}
	try {
		headSha = await fetchProviderHead(root, remote, request, headRef, options.signal)
		await ensureProviderBase(root, remote, metadata.baseRefName, request, options.signal)
		if (cached) {
			worktreeParent = await mkdtemp(join(tmpdir(), "kimchi-review-provider-"))
			worktreePath = join(worktreeParent, "checkout")
			try {
				await gitText(root, ["worktree", "add", "--detach", worktreePath, headSha], {
					signal: options.signal,
					lazyFetch: true,
				})
			} catch (error) {
				throw new ReviewTargetError(
					"provider_checkout",
					`Could not create the provider review checkout: ${errorMessage(error)}`,
				)
			}
		}
	} catch (error) {
		await cleanup().catch(() => {})
		throw error
	}
	return {
		root: worktreePath ?? root,
		remote,
		headRef,
		headRefName: metadata.headRefName,
		baseRefName: metadata.baseRefName,
		headSha,
		metadata,
		cleanup,
	}
}
