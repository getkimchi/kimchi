import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { listLegacyJobFiles } from "./capture-jobs.js"

export interface CaptureQueueAudit {
	jobs: number
	duplicateGroups: number
	duplicateJobs: number
	duplicateGroupSizes: Record<string, number>
	invalidJobs: number
	bytes: number
	/** Age of the oldest pending job's file mtime, absent for an empty queue. */
	oldestPendingAgeMs?: number
}

interface Envelope {
	dedupeSession?: unknown
	session?: unknown
	project?: { id?: unknown } | null
	messages?: unknown
}

function fingerprint(envelope: Envelope): string | undefined {
	const session = envelope.dedupeSession ?? envelope.session
	if (session !== undefined && typeof session !== "string") return undefined
	if (!Array.isArray(envelope.messages)) return undefined
	return createHash("sha256")
		.update(
			JSON.stringify({
				session,
				project: typeof envelope.project?.id === "string" ? envelope.project.id : null,
				messages: envelope.messages,
			}),
		)
		.digest("hex")
}

/** Queue counts and distributions only; transcript text never appears in the
 * result. Fingerprints deliberately exclude staging/runtime bookkeeping while
 * retaining the same dedupe session, project, and message body distinctions. */
export function auditCaptureQueue(root: string, now = Date.now()): CaptureQueueAudit {
	const files = listLegacyJobFiles(root)
	const groups = new Map<string, number>()
	const duplicateGroupSizes = new Map<number, number>()
	let invalidJobs = 0
	let bytes = 0
	let oldest = Number.POSITIVE_INFINITY
	for (const file of files) {
		const stats = statSync(file)
		bytes += stats.size
		oldest = Math.min(oldest, stats.mtimeMs)
		let parsed: unknown
		try {
			parsed = JSON.parse(readFileSync(file, "utf-8"))
		} catch {
			invalidJobs += 1
			continue
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			invalidJobs += 1
			continue
		}
		const key = fingerprint(parsed as Envelope)
		if (!key) {
			invalidJobs += 1
			continue
		}
		groups.set(key, (groups.get(key) ?? 0) + 1)
	}
	for (const size of groups.values()) {
		if (size > 1) duplicateGroupSizes.set(size, (duplicateGroupSizes.get(size) ?? 0) + 1)
	}
	const validJobs = files.length - invalidJobs
	return {
		jobs: files.length,
		duplicateGroups: [...groups.values()].filter((size) => size > 1).length,
		duplicateJobs: Math.max(0, validJobs - groups.size),
		duplicateGroupSizes: Object.fromEntries([...duplicateGroupSizes].map(([size, count]) => [String(size), count])),
		invalidJobs,
		bytes,
		...(Number.isFinite(oldest) ? { oldestPendingAgeMs: Math.max(0, now - oldest) } : {}),
	}
}
