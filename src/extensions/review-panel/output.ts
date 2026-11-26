import { createHash, randomUUID } from "node:crypto"
import { lstat, open, readFile, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { checkReviewDirectory } from "../review-submit/directory-safety.js"
import {
	DEFAULT_WRITER_LIMIT,
	FINDING_SCHEMA_VERSION,
	MAX_DERIVED_FROM_IDS,
	MAX_OUTPUT_FILE_BYTES,
	type ReviewFindingRecord,
	type ReviewSubmitContext,
	validateReviewFindingInput,
} from "../review-submit/store.js"
import { REVIEW_LENSES } from "./lenses.js"
import type { ReviewPanelCandidate } from "./types.js"

export function reviewPanelPaths(outputDir: string) {
	return {
		statePath: join(outputDir, "state", "panel.json"),
		routineChecksPath: join(outputDir, "state", "routine-checks.json"),
		reconciliationRequestPath: join(outputDir, "state", "reconciliation-request.json"),
		findingsPath: join(outputDir, "findings", "final.jsonl"),
		summaryPath: join(outputDir, "summary", "final.json"),
		repliesPath: join(outputDir, "replies", "final.jsonl"),
	}
}

async function checkedParent(path: string): Promise<void> {
	const checked = await checkReviewDirectory(dirname(path), { isDefault: false, create: true })
	if (checked.kind !== "ready") throw new Error(`Review output directory ${dirname(path)} is unavailable or unsafe.`)
}

export async function atomicWriteReviewFile(path: string, contents: string): Promise<void> {
	await checkedParent(path)
	const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		handle = await open(temporaryPath, "wx", 0o600)
		await handle.writeFile(contents, "utf8")
		await handle.sync()
		await handle.close()
		handle = undefined
		await rename(temporaryPath, path)
	} finally {
		await handle?.close().catch(() => {})
		await rm(temporaryPath, { force: true }).catch(() => {})
	}
}

export async function writeReviewJson(path: string, value: unknown): Promise<void> {
	await atomicWriteReviewFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function serializeFinalFindings(records: readonly ReviewFindingRecord[]): string {
	const contents = records.map((record) => `${JSON.stringify(record)}\n`).join("")
	if (records.length > DEFAULT_WRITER_LIMIT || Buffer.byteLength(contents, "utf8") > MAX_OUTPUT_FILE_BYTES) {
		throw new Error("Final review findings exceed the shared count or file-size limit.")
	}
	return contents
}

export async function createEmptyFinalCheckpoint(path: string): Promise<void> {
	await checkedParent(path)
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		handle = await open(path, "wx", 0o600)
		await handle.sync()
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error("A final review checkpoint already exists; resume it with wrapUpReviewPanel instead.")
		}
		throw error
	} finally {
		await handle?.close().catch(() => {})
	}
}

export async function writeFinalFindings(path: string, records: readonly ReviewFindingRecord[]): Promise<void> {
	await atomicWriteReviewFile(path, serializeFinalFindings(records))
}

function findingFields(record: ReviewFindingRecord) {
	return {
		path: record.path,
		line: record.line,
		severity: record.severity,
		type: record.type,
		description: record.description,
		suggestion: record.suggestion,
		...(record.derived_from === undefined ? {} : { derived_from: record.derived_from }),
	}
}

function parseRecord(value: unknown, writer: string, expectedSeq: number): ReviewFindingRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Finding is not an object.")
	const record = value as ReviewFindingRecord
	if (
		record.schema_version !== FINDING_SCHEMA_VERSION ||
		record.writer !== writer ||
		record.seq !== expectedSeq ||
		record.id !== `${writer}-${expectedSeq}` ||
		typeof record.created_at !== "string" ||
		!record.created_at ||
		record.created_at.includes("\0") ||
		Buffer.byteLength(record.created_at, "utf8") > 64
	) {
		throw new Error(`Writer ${writer} has an invalid finding identity or sequence at ${expectedSeq}.`)
	}
	return record
}

export async function readFindingWriter(
	path: string,
	writer: string,
	context: ReviewSubmitContext,
): Promise<ReviewFindingRecord[]> {
	let metadata: Awaited<ReturnType<typeof lstat>>
	try {
		metadata = await lstat(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
	if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${path} is not a regular finding writer file.`)
	if (metadata.size > MAX_OUTPUT_FILE_BYTES) throw new Error(`${path} exceeds the 1 MiB writer-file limit.`)
	const contents = await readFile(path, "utf8")
	const records: ReviewFindingRecord[] = []
	let expectedSeq = 1
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue
		if (line.includes("\0")) throw new Error(`${path} contains NUL.`)
		const record = parseRecord(JSON.parse(line), writer, expectedSeq)
		const invalid = await validateReviewFindingInput(findingFields(record), { ...context, writer })
		if (invalid) throw new Error(`${record.id} was rejected during candidate ingest: ${invalid.message}`)
		records.push(record)
		expectedSeq += 1
	}
	return records
}

function candidateOrder(left: ReviewPanelCandidate, right: ReviewPanelCandidate): number {
	const lensOrder = new Map(REVIEW_LENSES.map((lens, index) => [lens.id, index]))
	return (
		(lensOrder.get(left.lens) ?? REVIEW_LENSES.length) - (lensOrder.get(right.lens) ?? REVIEW_LENSES.length) ||
		left.finding.seq - right.finding.seq ||
		left.id.localeCompare(right.id)
	)
}

export function orderedCandidates(candidates: readonly ReviewPanelCandidate[]): ReviewPanelCandidate[] {
	return [...candidates].sort(candidateOrder)
}

export function candidateInputDigest(candidates: readonly ReviewPanelCandidate[]): string {
	return createHash("sha256")
		.update(JSON.stringify(orderedCandidates(candidates)))
		.digest("hex")
}

function exactKey(candidate: ReviewPanelCandidate): string {
	const { path, line, severity, type, description, suggestion } = candidate.finding
	return JSON.stringify({ path, line, severity, type, description, suggestion })
}

function rankSeverity(severity: string): number {
	return severity === "critical" ? 0 : severity === "warning" ? 1 : 2
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

interface FindingGroup {
	candidates: ReviewPanelCandidate[]
	finding: {
		id: string
		path: string
		line: number
		severity: string
		type: string
		description: string
		suggestion: string
	}
}

export interface PackedReviewFindings {
	records: ReviewFindingRecord[]
	/** Complete ordered provenance for every published finding, never truncated in durable state. */
	provenance: Record<string, string[]>
	provenanceTruncatedCount: number
}

function compareGroups(left: FindingGroup, right: FindingGroup): number {
	return (
		rankSeverity(left.finding.severity) - rankSeverity(right.finding.severity) ||
		compareText(left.finding.path, right.finding.path) ||
		left.finding.line - right.finding.line ||
		compareText(left.finding.type, right.finding.type) ||
		compareText(left.finding.description, right.finding.description) ||
		compareText(left.finding.suggestion, right.finding.suggestion) ||
		compareText(left.finding.id, right.finding.id) ||
		compareText(orderedCandidates(left.candidates)[0]?.id ?? "", orderedCandidates(right.candidates)[0]?.id ?? "")
	)
}

function packGroups(groups: FindingGroup[]): PackedReviewFindings {
	groups.sort(compareGroups)
	const records: ReviewFindingRecord[] = []
	const provenance: Record<string, string[]> = {}
	let provenanceTruncatedCount = 0
	for (const group of groups) {
		if (records.length >= DEFAULT_WRITER_LIMIT) break
		const sources = orderedCandidates(group.candidates)
		const completeDerivedFrom = [
			...new Set([
				...sources.map((candidate) => candidate.id),
				...sources.flatMap((candidate) => candidate.finding.derived_from ?? []),
			]),
		].sort(compareText)
		const derivedFrom = completeDerivedFrom.slice(0, MAX_DERIVED_FROM_IDS)
		const seq = records.length + 1
		const { path, line, severity, type, description, suggestion } = group.finding
		const record: ReviewFindingRecord = {
			schema_version: FINDING_SCHEMA_VERSION,
			id: `final-${seq}`,
			writer: "final",
			seq,
			created_at: sources.map((candidate) => candidate.finding.created_at).sort(compareText)[0],
			path,
			line,
			severity,
			type,
			description,
			suggestion,
			derived_from: derivedFrom,
		}
		const next = [...records, record]
		const nextContents = next.map((finding) => `${JSON.stringify(finding)}\n`).join("")
		if (Buffer.byteLength(nextContents, "utf8") > MAX_OUTPUT_FILE_BYTES) continue
		records.push(record)
		provenance[record.id] = completeDerivedFrom
		provenanceTruncatedCount += completeDerivedFrom.length - derivedFrom.length
	}
	return { records, provenance, provenanceTruncatedCount }
}

/** Exact-duplicate fallback. The source ID set is stable and semantic fields are
 * never merged merely because anchors or descriptions look similar. */
export function buildFallbackCheckpoint(candidates: readonly ReviewPanelCandidate[]): PackedReviewFindings {
	const groups = new Map<string, FindingGroup>()
	for (const candidate of orderedCandidates(candidates)) {
		const key = exactKey(candidate)
		const group = groups.get(key)
		if (group) group.candidates.push(candidate)
		else {
			const { path, line, severity, type, description, suggestion } = candidate.finding
			groups.set(key, {
				candidates: [candidate],
				finding: { id: key, path, line, severity, type, description, suggestion },
			})
		}
	}
	return packGroups([...groups.values()])
}

export function buildFallbackFindings(candidates: readonly ReviewPanelCandidate[]): ReviewFindingRecord[] {
	return buildFallbackCheckpoint(candidates).records
}

export function buildReconciledCheckpoint(
	groups: Array<{ candidates: ReviewPanelCandidate[]; finding: FindingGroup["finding"] }>,
): PackedReviewFindings {
	return packGroups(groups)
}

export function buildReconciledFindings(
	groups: Array<{ candidates: ReviewPanelCandidate[]; finding: FindingGroup["finding"] }>,
): ReviewFindingRecord[] {
	return buildReconciledCheckpoint(groups).records
}

export async function readFinalFindings(path: string): Promise<ReviewFindingRecord[]> {
	let metadata: Awaited<ReturnType<typeof lstat>>
	try {
		metadata = await lstat(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
	if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${path} is not a regular final findings file.`)
	if (metadata.size > MAX_OUTPUT_FILE_BYTES) throw new Error(`${path} exceeds the 1 MiB final findings limit.`)
	const contents = await readFile(path, "utf8")
	if (!contents.trim()) return []
	return contents
		.trim()
		.split("\n")
		.map((line, index) => parseRecord(JSON.parse(line), "final", index + 1))
}
