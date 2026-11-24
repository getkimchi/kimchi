import { gitBytes, gitResultError, resolveCommit } from "./git.js"
import { ReviewTargetError } from "./types.js"

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

export interface ResolvedRevision {
	ref: string
	commitSha: string
}

async function refExists(root: string, ref: string, signal?: AbortSignal): Promise<boolean> {
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
	const fullRef = /^(?:refs\/(?:heads|remotes)\/.+)$/.test(input) || (kind === "base" && /^refs\/tags\/.+$/.test(input))
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
