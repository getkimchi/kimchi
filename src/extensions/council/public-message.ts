import type { ChangeSet } from "../../agent-patch/index.js"
import type { CandidatePatch } from "./patch.js"

const CHANGE_OPERATION_KIND_ORDER = ["create", "update", "delete", "rename"] as const
type ChangeOperationKind = (typeof CHANGE_OPERATION_KIND_ORDER)[number]
const CHANGE_OPERATION_VERB: Record<ChangeOperationKind, string> = {
	create: "created",
	update: "updated",
	delete: "deleted",
	rename: "renamed",
}
const MAX_LISTED_CHANGED_FILES = 3
const GENERIC_CHANGE_SET_MESSAGE = "Applied the staged change."

function changedFileName(path: string): string {
	const segments = path.split("/")
	return segments[segments.length - 1] || path
}

function describeChangeGroup(kind: ChangeOperationKind, paths: readonly string[]): string {
	if (paths.length === 0) return ""
	const verb = CHANGE_OPERATION_VERB[kind]
	if (paths.length > MAX_LISTED_CHANGED_FILES) return `${verb} ${paths.length} files`
	if (paths.length === 1) return `${verb} ${changedFileName(paths[0])}`
	return `${verb} ${paths.map(changedFileName).join(", ")}`
}

function joinChangeGroupPhrases(phrases: readonly string[]): string {
	if (phrases.length === 0) return ""
	if (phrases.length === 1) return phrases[0]
	return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`
}

export function describeChangeSet(changeSet: ChangeSet): string {
	const grouped = new Map<ChangeOperationKind, string[]>()
	for (const operation of changeSet.operations) {
		const paths = grouped.get(operation.kind) ?? []
		paths.push(operation.path)
		grouped.set(operation.kind, paths)
	}
	const phrases = CHANGE_OPERATION_KIND_ORDER.map((kind) => describeChangeGroup(kind, grouped.get(kind) ?? [])).filter(
		Boolean,
	)
	if (phrases.length === 0) {
		const fileCount = changeSet.stats.files
		return fileCount > 0 ? `Updated ${fileCount} file${fileCount === 1 ? "" : "s"}.` : GENERIC_CHANGE_SET_MESSAGE
	}
	const sentence = joinChangeGroupPhrases(phrases)
	return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`
}

function safeDescribeChangeSet(changeSet: ChangeSet): string {
	try {
		const description = describeChangeSet(changeSet)
		return description.trim() ? description : GENERIC_CHANGE_SET_MESSAGE
	} catch {
		return GENERIC_CHANGE_SET_MESSAGE
	}
}

export function resolvePublicMessage(
	leadProse: string | undefined,
	synthesisSummary: string | undefined,
	changeSet: ChangeSet,
): string {
	if (leadProse?.trim()) return leadProse
	if (synthesisSummary?.trim()) return synthesisSummary
	return safeDescribeChangeSet(changeSet)
}

const NO_CHANGES_NEEDED_MESSAGE = "No changes were needed."

export function resolveNoOpPublicMessage(leadProse: string | undefined, synthesisSummary: string | undefined): string {
	if (leadProse?.trim()) return leadProse
	if (synthesisSummary?.trim()) return synthesisSummary
	return NO_CHANGES_NEEDED_MESSAGE
}

export function candidatePatchFromChangeSet(candidate: ChangeSet): CandidatePatch {
	return {
		operations: candidate.operations.map((operation) => {
			switch (operation.kind) {
				case "create":
					return { op: "create", path: operation.path, content: operation.content }
				case "update":
					return { op: "update", path: operation.path, content: operation.content }
				case "delete":
					return { op: "delete", path: operation.path }
				case "rename":
					return { op: "rename", path: operation.fromPath, new_path: operation.path }
				default:
					throw new Error("Council candidate contains an unsupported operation")
			}
		}),
	}
}
