import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { localAnchors, selectAnchors } from "../review-targets/anchors.js"
import { gitText, repositoryRoot, resolveCommit } from "../review-targets/git.js"
import type { ResolvedReviewTarget } from "../review-targets/types.js"
import { ReviewTargetError } from "../review-targets/types.js"

export const REVIEW_MANIFEST_SCHEMA_VERSION = "review-manifest/v1"
export const REVIEW_MANIFEST_FILENAME = "manifest.json"

const MANIFEST_FIELDS = [
	"schema_version",
	"base_sha",
	"head_sha",
	"checkout_path",
	"context_dir",
	"output_dir",
	"deadline",
] as const

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/

export interface ReviewManifest {
	schema_version: typeof REVIEW_MANIFEST_SCHEMA_VERSION
	base_sha: string
	head_sha: string
	checkout_path: string
	context_dir: string
	output_dir: string
	deadline: string
}

export interface PreparedReviewManifest {
	manifest: ReviewManifest
	target: ResolvedReviewTarget
	deadlineMs: number
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function invalid(message: string): ReviewTargetError {
	return new ReviewTargetError("invalid_manifest", message)
}

/** Strict RFC 3339 UTC instant. Offset forms, non-existent dates and leap seconds
 * are deliberately rejected because the process watchdog needs an exact epoch. */
export function parseReviewManifestDeadline(value: string): number {
	const match = UTC_TIMESTAMP.exec(value)
	if (!match) throw invalid("Review manifest deadline must be an absolute UTC RFC 3339 timestamp ending in Z.")
	const [, year, month, day, hour, minute, second] = match
	const numeric = [year, month, day, hour, minute, second].map(Number)
	const [yyyy, mm, dd, hh, min, ss] = numeric
	const calendar = new Date(Date.UTC(yyyy, mm - 1, dd))
	if (
		calendar.getUTCFullYear() !== yyyy ||
		calendar.getUTCMonth() !== mm - 1 ||
		calendar.getUTCDate() !== dd ||
		hh > 23 ||
		min > 59 ||
		ss > 59
	) {
		throw invalid(`Review manifest deadline is not a real UTC date and time: ${value}.`)
	}
	const parsed = Date.parse(value)
	if (!Number.isFinite(parsed)) throw invalid(`Review manifest deadline is invalid: ${value}.`)
	return parsed
}

export function validateReviewManifest(value: unknown): ReviewManifest {
	if (!object(value)) throw invalid("Review manifest must be a JSON object.")
	const actual = Object.keys(value).sort()
	const expected = [...MANIFEST_FIELDS].sort()
	const missing = expected.filter((field) => !(field in value))
	const extra = actual.filter((field) => !expected.includes(field as (typeof MANIFEST_FIELDS)[number]))
	if (missing.length || extra.length) {
		const problems = [
			...(missing.length ? [`missing fields: ${missing.join(", ")}`] : []),
			...(extra.length ? [`unexpected fields: ${extra.join(", ")}`] : []),
		]
		throw invalid(`Review manifest has ${problems.join("; ")}.`)
	}
	if (value.schema_version !== REVIEW_MANIFEST_SCHEMA_VERSION) {
		throw invalid(`Review manifest schema_version must be exactly ${REVIEW_MANIFEST_SCHEMA_VERSION}.`)
	}
	for (const field of ["base_sha", "head_sha"] as const) {
		if (typeof value[field] !== "string" || !OBJECT_ID.test(value[field] as string)) {
			throw invalid(`Review manifest ${field} must be a full lowercase Git commit ID.`)
		}
	}
	for (const field of ["checkout_path", "context_dir", "output_dir"] as const) {
		if (typeof value[field] !== "string" || !value[field] || !isAbsolute(value[field] as string)) {
			throw invalid(`Review manifest ${field} must be a non-empty absolute path.`)
		}
		if ((value[field] as string).includes("\0")) throw invalid(`Review manifest ${field} contains NUL.`)
	}
	if (typeof value.deadline !== "string") throw invalid("Review manifest deadline must be a string.")
	parseReviewManifestDeadline(value.deadline)
	return {
		schema_version: REVIEW_MANIFEST_SCHEMA_VERSION,
		base_sha: value.base_sha as string,
		head_sha: value.head_sha as string,
		checkout_path: resolve(value.checkout_path as string),
		context_dir: resolve(value.context_dir as string),
		output_dir: resolve(value.output_dir as string),
		deadline: value.deadline,
	}
}

export async function readReviewManifest(path: string): Promise<ReviewManifest> {
	let parsed: unknown
	try {
		parsed = JSON.parse(await readFile(path, "utf8"))
	} catch (error) {
		throw invalid(`Could not read review manifest ${path}: ${error instanceof Error ? error.message : String(error)}`)
	}
	return validateReviewManifest(parsed)
}

/** Validate the externally prepared checkout and normalize it to the same target
 * shape produced by stage 2. No refs, index contents, or working-tree files are changed. */
export async function prepareReviewManifestTarget(
	manifest: ReviewManifest,
	signal?: AbortSignal,
): Promise<PreparedReviewManifest> {
	const deadlineMs = parseReviewManifestDeadline(manifest.deadline)
	const root = await repositoryRoot(manifest.checkout_path, signal)
	if (root !== (await realpath(resolve(manifest.checkout_path)))) {
		throw new ReviewTargetError(
			"checkout_path_mismatch",
			`Review manifest checkout_path ${manifest.checkout_path} does not resolve to repository root ${root}.`,
		)
	}
	for (const [label, sha] of [
		["base_sha", manifest.base_sha],
		["head_sha", manifest.head_sha],
	] as const) {
		try {
			const resolved = await resolveCommit(root, sha, signal)
			if (resolved !== sha) throw new Error(`resolved to ${resolved}`)
		} catch (error) {
			throw new ReviewTargetError(
				"manifest_revision_mismatch",
				`Review manifest ${label} ${sha} does not match the prepared checkout ${root}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}
	const mergeBase = await gitText(root, ["merge-base", manifest.base_sha, manifest.head_sha], { signal })
	if (mergeBase !== manifest.base_sha) {
		throw new ReviewTargetError(
			"manifest_revision_mismatch",
			`Review manifest base_sha ${manifest.base_sha} is not the checkout merge base of ${manifest.head_sha}.`,
		)
	}

	const local = await localAnchors(root, manifest.base_sha, manifest.head_sha, signal)
	let provider: unknown
	try {
		provider = JSON.parse(await readFile(join(manifest.context_dir, "commentable-lines.json"), "utf8"))
	} catch {
		provider = undefined
	}
	const anchors = selectAnchors(local.map, provider, false, manifest.base_sha, manifest.head_sha)
	const target: ResolvedReviewTarget = {
		scope: {
			kind: "branch",
			refs: {
				branch: manifest.head_sha,
				base: manifest.base_sha,
				resolvedBase: manifest.base_sha,
				head: manifest.head_sha,
			},
			includeWorkingTree: false,
			baseSource: "explicit",
			pinned: { baseSha: manifest.base_sha, headSha: manifest.head_sha, tipSha: manifest.head_sha },
			headKind: "commit",
			dirty: false,
			files: local.files,
			anchorSource: anchors.source,
			checkoutPath: root,
			contextDir: manifest.context_dir,
			commentableLinesPath: join(manifest.context_dir, "commentable-lines.json"),
			limitations: anchors.limitations,
		},
		cleanup: async () => {},
	}
	// Durable panel identity and a later manifest must use the same canonical
	// repository path even when the supplied absolute path traverses a symlink.
	return { manifest: { ...manifest, checkout_path: root }, target, deadlineMs }
}

export async function loadPreparedReviewManifest(path: string, signal?: AbortSignal): Promise<PreparedReviewManifest> {
	const manifest = await readReviewManifest(path)
	return prepareReviewManifestTarget(manifest, signal)
}
