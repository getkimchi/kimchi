import { gitBytes, gitResultError, gitText, OBJECT_ID, optionalCommit, resolveCommit } from "./git.js"
import type { ReviewBranchPreference, ReviewTargetInteractions } from "./types.js"
import { ReviewTargetError } from "./types.js"

export interface ResolvedRevision {
	ref: string
	commitSha: string
}

export async function refExists(root: string, ref: string, signal?: AbortSignal): Promise<boolean> {
	const args = ["show-ref", "--verify", "--quiet", ref] as const
	const result = await gitBytes(root, args, { signal, allowFailure: true })
	if (result.exitCode === 0) return true
	if (result.exitCode === 1 && !result.failure?.code) return false
	if (result.exitCode === 1 && result.failure?.code === 1 && !result.stderr) return false
	throw gitResultError(args, result)
}

function invalidRef(ref: string): never {
	throw new ReviewTargetError("invalid_ref", `Ref "${ref}" must not be empty or start with an option prefix.`)
}

export async function resolveTargetRevision(
	root: string,
	input: string,
	kind: "branch" | "base",
	signal?: AbortSignal,
): Promise<ResolvedRevision> {
	if (!input || input.startsWith("-")) invalidRef(input)
	if (kind === "base" && OBJECT_ID.test(input))
		return { ref: input, commitSha: await resolveCommit(root, input, signal) }
	const fullRef =
		/^(?:refs\/(?:heads|remotes)\/.+)$/.test(input) ||
		(kind === "branch" && /^refs\/kimchi\/review\/(?:pr|mr)-\d+-[a-f0-9-]+$/.test(input)) ||
		(kind === "base" && /^refs\/tags\/.+$/.test(input))
	let candidates: string[]
	if (fullRef) candidates = [input]
	else {
		if (input.startsWith("refs/")) {
			throw new ReviewTargetError(
				"invalid_ref",
				`Ref "${input}" must be fully qualified under refs/heads, refs/remotes${kind === "base" ? ", or refs/tags" : ""}.`,
			)
		}
		candidates = [`refs/heads/${input}`, `refs/remotes/${input}`]
		if (kind === "base") candidates.push(`refs/tags/${input}`)
	}
	const tagRef = `refs/tags/${input}`
	if (!fullRef && kind === "branch") candidates.push(tagRef)
	const existing: string[] = []
	for (const candidate of candidates) if (await refExists(root, candidate, signal)) existing.push(candidate)
	if (kind === "branch" && existing.length === 1 && existing[0] === tagRef) {
		throw new ReviewTargetError(
			"unknown_revision",
			`"${input}" is a tag, not a branch. Use a branch ref, or pass the tag as --base.`,
		)
	}
	if (existing.length !== 1 || (kind === "branch" && existing.includes(tagRef))) {
		if (existing.length > 0) {
			throw new ReviewTargetError(
				"ambiguous_ref",
				`${kind === "branch" ? "Branch" : "Base"} ref "${input}" is ambiguous; use a fully qualified ref. Candidates: ${existing.join(", ")}.`,
			)
		}
		throw new ReviewTargetError(
			"unknown_revision",
			`Cannot resolve ${kind} ref "${input}". Checked: ${candidates.join(", ")}.`,
		)
	}
	const ref = existing[0]
	return { ref, commitSha: await resolveCommit(root, ref, signal) }
}

function hasRemotePrefix(input: string, remotes: readonly string[]): boolean {
	return remotes.some((remote) => input === remote || input.startsWith(`${remote}/`))
}

async function aheadBehind(root: string, localRef: string, remoteRef: string, signal?: AbortSignal) {
	const counts = (
		await gitText(root, ["rev-list", "--left-right", "--count", `${localRef}...${remoteRef}`], { signal })
	)
		.trim()
		.split(/\s+/)
		.map(Number)
	if (counts.length !== 2 || counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
		throw new ReviewTargetError(
			"branch_divergence",
			"Git returned invalid ahead/behind counts for the branch comparison.",
		)
	}
	return { ahead: counts[0], behind: counts[1] }
}

function shortSha(sha: string): string {
	return sha.slice(0, 7)
}

export interface ResolveBranchRevisionOptions {
	remote?: string
	configuredRemotes: readonly string[]
	prefer?: ReviewBranchPreference
	interactions?: ReviewTargetInteractions
	/** False when a full --fetch was already attempted for this resolution. */
	autoFetch: boolean
	signal?: AbortSignal
}

/** Resolve an unqualified branch against the selected remote, prompting only
 * when two different revisions are both plausible review targets. */
export async function resolveBranchTargetRevision(
	root: string,
	input: string,
	options: ResolveBranchRevisionOptions,
): Promise<ResolvedRevision> {
	const { remote, configuredRemotes, signal } = options
	const bare = !input.startsWith("refs/") && !hasRemotePrefix(input, configuredRemotes)
	if (bare && remote) {
		const localRef = `refs/heads/${input}`
		const remoteRef = `refs/remotes/${remote}/${input}`
		const [localSha, remoteSha, tagSha] = await Promise.all([
			optionalCommit(root, localRef, signal),
			optionalCommit(root, remoteRef, signal),
			optionalCommit(root, `refs/tags/${input}`, signal),
		])
		// A tag retains the historical ambiguity rules instead of being hidden
		// by the new local/remote selection flow.
		if (tagSha === undefined && localSha && remoteSha) {
			if (localSha === remoteSha) return { ref: localRef, commitSha: localSha }
			const counts = await aheadBehind(root, localRef, remoteRef, signal)
			const choice = {
				branch: input,
				remote,
				local: { ref: localRef, sha: localSha, ...counts },
				remoteRevision: { ref: remoteRef, sha: remoteSha },
			}
			const selected =
				options.prefer ??
				(options.interactions?.chooseBranchRevision
					? await options.interactions.chooseBranchRevision(choice)
					: undefined)
			if (!selected) {
				throw new ReviewTargetError(
					"branch_revision_choice_required",
					`Branch "${input}" has different local and remote revisions: ${localRef} (${shortSha(localSha)}, ${counts.ahead} ahead, ${counts.behind} behind) and ${remoteRef} (${shortSha(remoteSha)}). Choose with --prefer local or --prefer remote.`,
				)
			}
			return selected === "local" ? { ref: localRef, commitSha: localSha } : { ref: remoteRef, commitSha: remoteSha }
		}
		if (tagSha === undefined && remoteSha && !localSha) return { ref: remoteRef, commitSha: remoteSha }
		if (tagSha === undefined && localSha) return { ref: localRef, commitSha: localSha }
	}

	try {
		return await resolveTargetRevision(root, input, "branch", signal)
	} catch (error) {
		if (
			!(error instanceof ReviewTargetError) ||
			error.code !== "unknown_revision" ||
			!remote ||
			!options.autoFetch ||
			!bare
		) {
			throw error
		}
	}

	const remoteRef = `refs/remotes/${remote}/${input}`
	try {
		await gitText(
			root,
			["fetch", "--no-tags", "--no-recurse-submodules", remote, `+refs/heads/${input}:${remoteRef}`],
			{ signal, lazyFetch: true },
		)
		const remoteSha = await optionalCommit(root, remoteRef, signal)
		if (remoteSha) return { ref: remoteRef, commitSha: remoteSha }
	} catch (error) {
		if (signal?.aborted) throw error
		// Replace transport details with a bounded, ref-specific error. Provider
		// credentials embedded in a configured URL are never copied into it.
	}
	throw new ReviewTargetError(
		"unknown_revision",
		`Cannot resolve branch ref "${input}" locally or as ${remoteRef}; one narrow fetch from ${remote} was attempted. Supply a valid branch or a fully qualified ref.`,
	)
}
