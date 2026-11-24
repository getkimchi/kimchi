import { gitBytes, gitText } from "./git.js"
import type { CommentableFile, ProviderAnchorMap, ReviewLimitation } from "./types.js"
import { ReviewTargetError } from "./types.js"

const COMMENTABLE_LINES_VERSION = "commentable-lines/v1"
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

interface ParsedPatchFile {
	file: CommentableFile
}

export interface LocalAnchors {
	map: ProviderAnchorMap
	files: {
		changed: number
		anchorable: number
		unanchorable: number
	}
}

export interface AnchorSelection {
	map: ProviderAnchorMap
	source: "local" | "provider"
	limitations: ReviewLimitation[]
}

function parsePatch(patch: string): ParsedPatchFile[] {
	const files: ParsedPatchFile[] = []
	let ranges: { start_line: number; end_line: number }[] = []
	let sawHeader = false
	const finish = () => {
		if (!sawHeader) return
		files.push({ file: ranges.length ? { ranges } : { reason: "no_patch" } })
		ranges = []
	}
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			finish()
			sawHeader = true
			continue
		}
		if (!sawHeader) continue
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
		if (!hunk) continue
		const startLine = Number(hunk[1])
		const count = hunk[2] === undefined ? 1 : Number(hunk[2])
		if (count > 0) ranges.push({ start_line: startLine, end_line: startLine + count - 1 })
	}
	finish()
	return files
}

/** Compute inclusive new-side line ranges without applying provider data to local line numbers. */
export async function localAnchors(
	root: string,
	baseSha: string,
	headSha: string,
	signal?: AbortSignal,
): Promise<LocalAnchors> {
	const namesResult = await gitBytes(
		root,
		["diff", "--name-only", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", baseSha, headSha, "--"],
		{ signal },
	)
	const names = namesResult.stdout.toString("utf8").split("\0").filter(Boolean)
	const patch = await gitText(
		root,
		["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=0", "--find-renames", baseSha, headSha, "--"],
		{ signal },
	)
	const parsed = parsePatch(patch)
	if (parsed.length !== names.length) {
		throw new ReviewTargetError(
			"diff_parse",
			`Git returned ${names.length} changed paths but ${parsed.length} parseable patch entries.`,
		)
	}
	// Object.fromEntries creates own data properties even for prototype names.
	const files = Object.fromEntries(names.map((name, index) => [name, parsed[index].file]))
	const anchorable = parsed.filter((entry) => (entry.file.ranges?.length ?? 0) > 0).length
	return {
		map: {
			schema_version: COMMENTABLE_LINES_VERSION,
			commit_sha: headSha,
			merge_base_sha: baseSha,
			files_cap_reached: false,
			files,
		},
		files: { changed: names.length, anchorable, unanchorable: names.length - anchorable },
	}
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validProviderMap(value: unknown): value is ProviderAnchorMap {
	if (!object(value) || value.schema_version !== COMMENTABLE_LINES_VERSION) return false
	if (typeof value.commit_sha !== "string" || typeof value.merge_base_sha !== "string") return false
	if (value.files_cap_reached !== undefined && typeof value.files_cap_reached !== "boolean") return false
	if (!object(value.files)) return false
	for (const [path, candidate] of Object.entries(value.files)) {
		if (!path || path.includes("\0") || !object(candidate)) return false
		if (candidate.reason !== undefined && (typeof candidate.reason !== "string" || !candidate.reason)) return false
		if (candidate.ranges !== undefined) {
			if (!Array.isArray(candidate.ranges)) return false
			for (const range of candidate.ranges) {
				if (!object(range)) return false
				const start = range.start_line
				const end = range.end_line
				if (
					typeof start !== "number" ||
					typeof end !== "number" ||
					!Number.isInteger(start) ||
					!Number.isInteger(end) ||
					start < 1 ||
					end < start
				)
					return false
			}
		}
	}
	return true
}

export function selectAnchors(
	local: ProviderAnchorMap,
	provider: unknown,
	dirty: boolean,
	baseSha: string,
	headSha: string,
): AnchorSelection {
	if (dirty) {
		return {
			map: local,
			source: "local",
			limitations: [
				{
					code: "provider_anchor_map_not_applicable",
					message:
						"A dirty working tree has no provider comparison. Inline anchors were computed locally from the frozen snapshot.",
				},
			],
		}
	}
	if (provider === undefined) {
		return {
			map: local,
			source: "local",
			limitations: [
				{
					code: "provider_anchor_map_unavailable",
					message:
						"No provider anchor map was supplied. Inline anchors are local and still require fresh provider validation before publishing.",
				},
			],
		}
	}
	if (!validProviderMap(provider)) {
		return {
			map: local,
			source: "local",
			limitations: [
				{
					code: "provider_anchor_map_rejected",
					message: "The provider anchor map has an invalid shape. Local source anchors were used instead.",
				},
			],
		}
	}
	if (
		!OBJECT_ID.test(provider.commit_sha) ||
		!OBJECT_ID.test(provider.merge_base_sha) ||
		provider.commit_sha !== headSha ||
		provider.merge_base_sha !== baseSha
	) {
		return {
			map: local,
			source: "local",
			limitations: [
				{
					code: "provider_anchor_map_mismatch",
					message:
						"The provider anchor map does not identify the exact pinned base and head object IDs. Local source anchors were used instead.",
				},
			],
		}
	}
	return { map: provider, source: "provider", limitations: [] }
}
