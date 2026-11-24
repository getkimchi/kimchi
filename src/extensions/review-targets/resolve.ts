import { randomUUID } from "node:crypto"
import { open, rename, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { checkReviewDirectory } from "../review-submit/directory-safety.js"
import { resolveReviewDirectories } from "../review-submit/paths.js"
import { localAnchors, selectAnchors } from "./anchors.js"
import {
	errorMessage,
	gitBytes,
	gitResultError,
	gitText,
	optionalCommit,
	repositoryRoot,
	resolveCommit,
	withReviewTargetFetchAuthorization,
} from "./git.js"
import { assertNoConversionDrivers } from "./preflight.js"
import { resolveTargetRevision } from "./refs.js"
import { deleteSnapshotRef, freezeWorkingTree, inspectWorkingTree, removeStaleSnapshots } from "./snapshot.js"
import type {
	BranchReviewRequest,
	CleanupReviewSnapshotOptions,
	CleanupStaleReviewSnapshotsOptions,
	ExplicitReviewRequest,
	ResolvedReviewScope,
	ResolvedReviewTarget,
	ResolveReviewTargetOptions,
	ReviewBaseSuggestion,
	ReviewInvocationOptions,
	ReviewTargetChoices,
} from "./types.js"
import { REVIEW_TARGET_SYNTAX, ReviewTargetError } from "./types.js"

async function remotes(root: string, signal?: AbortSignal): Promise<string[]> {
	return (await gitText(root, ["remote"], { signal })).split("\n").filter(Boolean).sort()
}

function remoteFromRef(ref: string | undefined, configured: string[]): string | undefined {
	if (!ref) return undefined
	const candidates = configured
		.map((remote) => ({ remote, prefixes: [`refs/remotes/${remote}/`, `${remote}/`] }))
		.flatMap(({ remote, prefixes }) => prefixes.map((prefix) => ({ remote, prefix })))
		.sort((left, right) => right.prefix.length - left.prefix.length)
	return candidates.find(({ prefix }) => ref.startsWith(prefix))?.remote
}

async function selectedRemote(
	root: string,
	options: ReviewInvocationOptions,
	refs: (string | undefined)[] = [],
): Promise<{ name?: string; configured: string[] }> {
	const configured = await remotes(root, options.signal)
	if (options.remote !== undefined) {
		if (!configured.includes(options.remote)) {
			throw new ReviewTargetError("unknown_remote", `Remote "${options.remote}" is not configured in this checkout.`)
		}
		return { name: options.remote, configured }
	}
	for (const ref of refs) {
		const remote = remoteFromRef(ref, configured)
		if (remote) return { name: remote, configured }
	}
	return {
		name: configured.includes("origin") ? "origin" : configured.length === 1 ? configured[0] : undefined,
		configured,
	}
}

async function fetchRemote(root: string, remote: string | undefined, signal?: AbortSignal): Promise<void> {
	if (!remote) {
		throw new ReviewTargetError(
			"remote_required",
			"--fetch needs an unambiguous configured remote. Select a remote or include one in the ref name.",
		)
	}
	await gitText(root, ["fetch", "--no-tags", "--no-recurse-submodules", remote], { signal, lazyFetch: true })
}

async function symbolicRef(root: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {
	const result = await gitBytes(root, ["symbolic-ref", "--quiet", ref], { signal, allowFailure: true })
	if (result.exitCode !== 0) {
		if (result.failure && typeof result.failure.code !== "number") throw gitResultError(["symbolic-ref", ref], result)
		return undefined
	}
	return result.stdout.toString("utf8").trim() || undefined
}

async function pullRequestBase(
	root: string,
	branch: string | undefined,
	configuredRemotes: string[],
	selected: string | undefined,
	signal?: AbortSignal,
): Promise<ReviewBaseSuggestion | undefined> {
	if (!branch) return undefined
	const orderedRemotes = selected ? [selected] : configuredRemotes
	const candidates = branch.startsWith("refs/")
		? [branch]
		: [...orderedRemotes.map((remote) => `refs/remotes/${remote}/${branch}`), `refs/heads/${branch}`, branch]
	for (const ref of [...new Set(candidates)]) {
		if (await optionalCommit(root, ref, signal)) {
			return { ref, resolvedRef: ref, source: "pull-request-target", remote: selected }
		}
	}
	return undefined
}

async function remoteDefaultBase(
	root: string,
	remote: string | undefined,
	configuredRemotes: string[],
	signal?: AbortSignal,
): Promise<ReviewBaseSuggestion | undefined> {
	const candidates = remote ? [remote] : configuredRemotes
	const suggestions: ReviewBaseSuggestion[] = []
	for (const name of candidates) {
		const ref = `refs/remotes/${name}/HEAD`
		const resolvedRef = await symbolicRef(root, ref, signal)
		if (!resolvedRef || !(await optionalCommit(root, ref, signal))) continue
		suggestions.push({ ref, resolvedRef, source: "remote-default", remote: name })
	}
	return suggestions.length === 1 ? suggestions[0] : undefined
}

async function suggestBase(
	root: string,
	options: ReviewInvocationOptions,
	remote: string | undefined,
	configuredRemotes: string[],
): Promise<ReviewBaseSuggestion | undefined> {
	return (
		(await pullRequestBase(root, options.pullRequestTargetBranch, configuredRemotes, remote, options.signal)) ??
		(await remoteDefaultBase(root, remote, configuredRemotes, options.signal))
	)
}

/** Return picker data only; selecting and rendering a choice belongs to the surface adapter. */
export async function getReviewTargetChoices(
	request: { kind: "bare"; fetch: boolean },
	options: ReviewInvocationOptions,
): Promise<ReviewTargetChoices> {
	return withReviewTargetFetchAuthorization(request.fetch, async () => {
		const root = await repositoryRoot(options.root, options.signal)
		await assertNoConversionDrivers(root, options.signal)
		const remote = await selectedRemote(root, options)
		if (request.fetch) await fetchRemote(root, remote.name, options.signal)
		const [inspection, baseSuggestion] = await Promise.all([
			inspectWorkingTree(root, options.signal),
			suggestBase(root, options, remote.name, remote.configured),
		])
		const dirty = inspection.status !== "clean"
		return {
			choices: [
				{ kind: "working-tree", preselected: dirty },
				{
					kind: "branch",
					preselected: !dirty,
					baseSuggestion,
					requiresExplicitBase: baseSuggestion === undefined,
				},
			],
			syntax: REVIEW_TARGET_SYNTAX,
			workingTreeStatus: inspection.status,
			flaggedPaths: inspection.flaggedPaths,
			flaggedPathCount: inspection.flaggedPathCount,
		}
	})
}

async function mergeBase(root: string, baseSha: string, tipSha: string, signal?: AbortSignal): Promise<string> {
	const args = ["merge-base", baseSha, tipSha] as const
	const result = await gitBytes(root, args, { signal, allowFailure: true })
	const sha = result.stdout.toString("utf8").trim()
	if (result.exitCode !== 0 && (result.exitCode !== 1 || result.failure?.code !== 1)) {
		throw gitResultError(args, result)
	}
	if (result.exitCode !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
		throw new ReviewTargetError(
			"no_merge_base",
			`The selected base and branch have no usable merge base${result.stderr.trim() ? `: ${result.stderr.trim()}` : "."}`,
		)
	}
	return sha
}

async function writeAnchorMap(contextDir: string, contents: unknown): Promise<string> {
	const destination = join(contextDir, "commentable-lines.json")
	const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		handle = await open(temporary, "wx", 0o600)
		await handle.writeFile(`${JSON.stringify(contents, null, 2)}\n`, "utf8")
		await handle.sync()
		await handle.close()
		handle = undefined
		await rename(temporary, destination)
		return destination
	} finally {
		await handle?.close().catch(() => {})
		await rm(temporary, { force: true }).catch(() => {})
	}
}

async function comparison(
	root: string,
	request: BranchReviewRequest,
	options: ResolveReviewTargetOptions,
): Promise<{ baseRef: string; baseSha: string; tipSha: string; source: ResolvedReviewScope["baseSource"] }> {
	const remote = await selectedRemote(root, options, [request.branch, request.base])
	if (request.fetch) await fetchRemote(root, remote.name, options.signal)
	const tipSha = (await resolveTargetRevision(root, request.branch, "branch", options.signal)).commitSha
	if (request.includeWorkingTree) {
		const checkoutHead = await resolveCommit(root, "HEAD", options.signal)
		if (checkoutHead !== tipSha) {
			throw new ReviewTargetError(
				"head_mismatch",
				`--include-working-tree requires ${request.branch} (${tipSha}) to equal the checkout HEAD (${checkoutHead}).`,
			)
		}
	}
	let baseSuggestion: ReviewBaseSuggestion | undefined
	if (request.base === undefined) baseSuggestion = await suggestBase(root, options, remote.name, remote.configured)
	if (!request.base && !baseSuggestion) {
		throw new ReviewTargetError(
			"base_required",
			"No PR/MR target branch or unique remote default branch is available. Supply --base <ref> explicitly.",
		)
	}
	const baseRef = request.base ?? baseSuggestion?.ref
	if (!baseRef) throw new ReviewTargetError("base_required", "Supply --base <ref> explicitly.")
	const baseRevision = await resolveTargetRevision(root, baseRef, "base", options.signal)
	return {
		baseRef: baseRevision.ref,
		baseSha: await mergeBase(root, baseRevision.commitSha, tipSha, options.signal),
		tipSha,
		source: request.base !== undefined ? "explicit" : (baseSuggestion?.source ?? "explicit"),
	}
}

/** Resolve an explicit target to immutable object IDs and materialize its applicable anchor map. */
export async function resolveReviewTarget(
	request: ExplicitReviewRequest,
	options: ResolveReviewTargetOptions,
): Promise<ResolvedReviewTarget> {
	return withReviewTargetFetchAuthorization(request.fetch, async () => {
		const root = await repositoryRoot(options.root, options.signal)
		let baseRef = "HEAD"
		let baseSha: string
		let tipSha: string
		let baseSource: ResolvedReviewScope["baseSource"] = "head"
		if (request.kind === "branch") {
			const selected = await comparison(root, request, options)
			baseRef = selected.baseRef
			baseSha = selected.baseSha
			tipSha = selected.tipSha
			baseSource = selected.source
		} else {
			const remote = await selectedRemote(root, options)
			if (request.fetch) await fetchRemote(root, remote.name, options.signal)
			tipSha = await resolveCommit(root, "HEAD", options.signal)
			baseSha = tipSha
		}

		const snapshot =
			request.kind === "working-tree" || request.includeWorkingTree
				? await freezeWorkingTree(root, tipSha, {
						signal: options.signal,
						beforeSnapshotCommit: options.beforeSnapshotCommit,
					})
				: { tipSha, headSha: tipSha, dirty: false, ref: undefined, cleanup: async () => {} }
		try {
			const projectDir = resolve(options.root)
			const directories = resolveReviewDirectories(projectDir, { contextDir: options.contextDir })
			const checked = await checkReviewDirectory(directories.contextDir, {
				projectDir,
				isDefault: directories.contextDirIsDefault === true,
				create: true,
			})
			if (checked.kind !== "ready") {
				throw new ReviewTargetError(
					"unsafe_context_dir",
					`Review context directory ${directories.contextDir} is ${checked.kind}${checked.kind === "unsafe" ? `: ${checked.reason}` : "."}`,
				)
			}
			const local = await localAnchors(root, baseSha, snapshot.headSha, options.signal)
			const selection = selectAnchors(local.map, options.providerAnchorMap, snapshot.dirty, baseSha, snapshot.headSha)
			const commentableLinesPath = await writeAnchorMap(checked.path, selection.map)
			const cleanup = async () => snapshot.cleanup()
			const scope: ResolvedReviewScope = {
				kind: request.kind,
				refs: {
					...(request.kind === "branch" ? { branch: request.branch, base: request.base } : {}),
					resolvedBase: baseRef,
					head: request.kind === "branch" ? request.branch : "working-tree",
				},
				includeWorkingTree: request.kind === "working-tree" || request.includeWorkingTree,
				baseSource,
				pinned: {
					baseSha,
					headSha: snapshot.headSha,
					tipSha,
					...(snapshot.ref ? { snapshotRef: snapshot.ref } : {}),
				},
				headKind: snapshot.ref ? "working-tree-snapshot" : "commit",
				dirty: snapshot.dirty,
				files: local.files,
				anchorSource: selection.source,
				checkoutPath: root,
				contextDir: checked.path,
				commentableLinesPath,
				limitations: selection.limitations,
			}
			return { scope, cleanup }
		} catch (error) {
			await snapshot.cleanup().catch(() => {})
			if (error instanceof ReviewTargetError) throw error
			throw new ReviewTargetError("target_resolution", `Could not resolve the review target: ${errorMessage(error)}`)
		}
	})
}

/** Recovery entry point for callers that persisted the scope instead of retaining its cleanup closure. */
export async function cleanupReviewSnapshot(options: CleanupReviewSnapshotOptions): Promise<void> {
	const root = await repositoryRoot(options.root, options.signal)
	await deleteSnapshotRef(root, options.ref, options.expectedHeadSha, options.signal)
}

/** Reclaim private refs left when a resolver was interrupted before returning its scope. */
export async function cleanupStaleReviewSnapshots(options: CleanupStaleReviewSnapshotsOptions) {
	const root = await repositoryRoot(options.root, options.signal)
	return removeStaleSnapshots(root, options.olderThanMs, options.signal)
}
