import { randomUUID } from "node:crypto"
import { lstat, open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { checkReviewDirectory } from "./directory-safety.js"
import type { ReviewDirectories } from "./paths.js"
import { WriterLockReleaseError, WriterLockUnavailableError, withSQLiteWriterLock } from "./sqlite-lock.js"

export const FINDING_SCHEMA_VERSION = "review-finding/v1"
export const SUMMARY_SCHEMA_VERSION = "review-summary/v1"
export const REPLY_SCHEMA_VERSION = "review-reply/v1"
export const MAX_OUTPUT_FILE_BYTES = 1 << 20
export const MAX_SUMMARY_BODY_BYTES = 64 * 1024
export const DEFAULT_WRITER_LIMIT = 50
export const MAX_DERIVED_FROM_IDS = 50
export const REPLY_LIMIT = 30
export const REVIEW_FINDING_PRIORITIES = ["P0", "P1", "P2", "P3", "P4"] as const
export const REVIEW_FINDING_TYPES = [
	"bug",
	"security",
	"reliability",
	"performance",
	"convention",
	"test-gap",
	"docs",
] as const
export const FINDING_TEXT_LIMITS = {
	title: 80,
	description: 250,
	explanation: 2000,
	suggestion: 500,
} as const

const COMMENTABLE_LINES_SCHEMA_VERSION = "commentable-lines/v1"
const COMMENTS_SCHEMA_VERSION = "review-comments/v1"
const MAX_CONSUMER_INT32 = 2_147_483_647
const WRITER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const UTC_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|\+00:00)$/i

const FINDING_FIELDS = [
	"path",
	"line",
	"title",
	"description",
	"explanation",
	"suggestion",
	"priority",
	"type",
	"derived_from",
]
const FINDING_RECORD_FIELDS = ["schema_version", "id", "writer", "seq", "created_at", ...FINDING_FIELDS]
const SUMMARY_FIELDS = ["body", "score", "estimated_effort_to_review", "environment_gaps", "coverage"]
const COVERAGE_FIELDS = [
	"status",
	"unfinished_lenses",
	"selected_lenses",
	"submitted_lenses",
	"failed_lenses",
	"cancelled_lenses",
	"candidate_count",
	"final_finding_count",
	"provenance_truncated_count",
	"findings_by_priority",
]
const REPLY_FIELDS = ["thread_id", "body", "action", "verdict", "evidence_kind", "evidence"]
const PRIORITIES = new Set<string>(REVIEW_FINDING_PRIORITIES)
const FINDING_TYPES = new Set<string>(REVIEW_FINDING_TYPES)
const ACTIONS = new Set(["resolve", "reopen", "none"])
const VERDICTS = new Set(["fixed", "not_fixed", "partially_fixed", "no_longer_applicable", "regressed", "unverified"])
const EVIDENCE_KINDS = new Set(["code_reference", "existing_test", "new_test", "none"])

export type ReviewFindingPriority = (typeof REVIEW_FINDING_PRIORITIES)[number]
export type ReviewFindingType = (typeof REVIEW_FINDING_TYPES)[number]
export interface FindingInput {
	path: string
	line: number
	title: string
	description: string
	explanation: string
	suggestion: string
	priority: ReviewFindingPriority
	type: ReviewFindingType
	derived_from?: string[]
}

export interface ReviewFindingRecord extends FindingInput {
	schema_version: typeof FINDING_SCHEMA_VERSION
	id: string
	writer: string
	seq: number
	created_at: string
}

export interface EnvironmentGap {
	kind: string
	name: string
	note: string
}

/** Optional review-summary/v1 coverage. Counts stay structured so consumers
 * that predate panel support can safely ignore this object. */
export interface ReviewCoverage {
	status: "complete" | "partial"
	unfinished_lenses: string[]
	selected_lenses: number
	submitted_lenses: number
	failed_lenses: number
	cancelled_lenses: number
	candidate_count: number
	final_finding_count: number
	/** Number of source IDs omitted from published derived_from arrays; full lists remain in panel state. */
	provenance_truncated_count: number
	findings_by_priority: Record<ReviewFindingPriority, number>
}

export interface SummaryInput {
	body: string
	score?: number
	estimated_effort_to_review?: number
	environment_gaps?: EnvironmentGap[]
	coverage?: ReviewCoverage
}

export interface ReviewSummaryRecord {
	schema_version: typeof SUMMARY_SCHEMA_VERSION
	writer: string
	created_at: string
	body: string
	score?: number
	estimated_effort_to_review?: number
	environment_gaps: EnvironmentGap[]
	coverage?: ReviewCoverage
}

export interface ReplyInput {
	thread_id: string
	body: string
	action: string
	verdict?: string
	evidence_kind?: string
	evidence?: string
}

export interface ReviewReplyRecord extends ReplyInput {
	schema_version: typeof REPLY_SCHEMA_VERSION
	id: string
	writer: string
	seq: number
	created_at: string
}

export interface ReviewSubmitContext extends ReviewDirectories {
	writer: string
	writerLimit?: number
	now?: () => Date
	/** @internal Test-only injection before acquiring the writer lock. */
	beforeAcquire?: () => void | Promise<void>
	/** @internal Test-only crash injection after temp-file sync and before rename. */
	beforeRename?: () => void | Promise<void>
	/** @internal Test-only injection after the operation and before lock release. */
	beforeRelease?: () => void | Promise<void>
}

export interface SubmitResult {
	accepted: boolean
	message: string
	id?: string
	seq?: number
	reason?: string
	field?: string
	limit?: number
	count?: number
	prioritize?: boolean
	nearest_valid_line?: number
	ranges?: CommentableRange[]
	summary_required?: boolean
	file_reason?: string
	actual_length?: number
}

interface CommentableRange {
	start_line: number
	end_line: number
}

interface CommentableFile {
	ranges?: CommentableRange[]
	reason?: string
}

interface CommentableLines {
	schema_version: string
	files_cap_reached?: boolean
	files: Record<string, CommentableFile>
}

interface ReviewThread {
	thread_id: string
	is_ours: boolean
	mentions_bot: boolean
}

function accepted(message: string, id?: string, seq?: number): SubmitResult {
	return { accepted: true, message, ...(id === undefined ? {} : { id }), ...(seq === undefined ? {} : { seq }) }
}

function rejected(reason: string, message: string, details: Partial<SubmitResult> = {}): SubmitResult {
	return { accepted: false, reason, message, ...details }
}

function invalidField(field: string, message: string, limit?: number): SubmitResult {
	return rejected("invalid_field", message, { field, ...(limit === undefined ? {} : { limit }) })
}

function utf8Length(value: string): number {
	return Buffer.byteLength(value, "utf8")
}

function validateString(
	value: unknown,
	field: string,
	maxBytes: number,
	options: { required?: boolean; allowEmpty?: boolean } = {},
): SubmitResult | undefined {
	if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
		return invalidField(field, `${field} must be a${options.allowEmpty ? " string" : " non-empty string"}.`)
	}
	if (value.includes("\0")) return invalidField(field, `${field} must not contain NUL.`)
	if (utf8Length(value) > maxBytes) {
		return invalidField(field, `${field} exceeds the ${maxBytes}-byte limit.`, maxBytes)
	}
	return undefined
}

function validateInteger(value: unknown, field: string, minimum: number, maximum?: number): SubmitResult | undefined {
	if (
		!Number.isInteger(value) ||
		(value as number) < minimum ||
		(maximum !== undefined && (value as number) > maximum)
	) {
		const range = maximum === undefined ? `at least ${minimum}` : `between ${minimum} and ${maximum}`
		return invalidField(field, `${field} must be an integer ${range}.`)
	}
	return undefined
}

function validateFindingText(value: unknown, field: keyof typeof FINDING_TEXT_LIMITS): SubmitResult | undefined {
	if (typeof value !== "string") {
		return invalidField(
			field,
			`${field} is required and must be a string of 1 to ${FINDING_TEXT_LIMITS[field]} Unicode code points after trimming.`,
		)
	}
	if (field === "title") {
		if (/\p{Cc}/u.test(value) || /[\u2028\u2029]/.test(value)) {
			return invalidField(field, "title must be a single line and must not contain control characters.")
		}
	} else if (value.includes("\0")) {
		return invalidField(field, `${field} must not contain NUL.`)
	}
	const length = Array.from(value.trim()).length
	const limit = FINDING_TEXT_LIMITS[field]
	if (length < 1 || length > limit) {
		return rejected(
			"invalid_field",
			`${field} must contain 1 to ${limit} Unicode code points after trimming; actual length is ${length}. Rewrite ${field} to fit the limit without dropping essential information.`,
			{ field, limit, actual_length: length },
		)
	}
	return undefined
}

export function normalizeFindingInput(input: FindingInput): FindingInput {
	return {
		...input,
		title: input.title.trim(),
		description: input.description.trim(),
		explanation: input.explanation.trim(),
		suggestion: input.suggestion.trim(),
	}
}

function validateFields(input: Record<string, unknown>, allowed: string[]): SubmitResult | undefined {
	for (const field of Object.keys(input)) {
		if (!allowed.includes(field)) return invalidField(field, `${field} is not an accepted field.`)
	}
	return undefined
}

function validateWriter(writer: string): SubmitResult | undefined {
	if (!WRITER_PATTERN.test(writer)) {
		return rejected("invalid_writer", "--review-writer must contain only letters, digits, underscores, or hyphens.", {
			field: "writer",
		})
	}
	return undefined
}

function validateCoverage(coverage: ReviewCoverage | undefined): SubmitResult | undefined {
	if (coverage === undefined) return undefined
	if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
		return invalidField("coverage", "coverage must be an object.")
	}
	const unknown = validateFields(coverage as unknown as Record<string, unknown>, COVERAGE_FIELDS)
	if (unknown) return unknown
	if (coverage.status !== "complete" && coverage.status !== "partial") {
		return invalidField("coverage.status", "coverage.status must be complete or partial.")
	}
	for (const field of [
		"selected_lenses",
		"submitted_lenses",
		"failed_lenses",
		"cancelled_lenses",
		"candidate_count",
		"final_finding_count",
		"provenance_truncated_count",
	] as const) {
		const error = validateInteger(coverage[field], `coverage.${field}`, 0)
		if (error) return error
	}
	if (!Array.isArray(coverage.unfinished_lenses))
		return invalidField("coverage.unfinished_lenses", "Expected an array.")
	if (
		coverage.submitted_lenses + coverage.failed_lenses + coverage.cancelled_lenses > coverage.selected_lenses ||
		(coverage.status === "complete" && coverage.unfinished_lenses.length !== 0) ||
		(coverage.status === "partial" && coverage.unfinished_lenses.length === 0) ||
		coverage.unfinished_lenses.length > coverage.selected_lenses
	) {
		return invalidField("coverage", "coverage counts and unfinished lenses are inconsistent.")
	}
	if (!coverage.findings_by_priority || typeof coverage.findings_by_priority !== "object") {
		return invalidField("coverage.findings_by_priority", "coverage.findings_by_priority must be an object.")
	}
	const priorityCounts = coverage.findings_by_priority as unknown as Record<string, unknown>
	const unknownPriority = validateFields(priorityCounts, [...REVIEW_FINDING_PRIORITIES])
	if (unknownPriority) return unknownPriority
	let priorityTotal = 0
	for (const priority of REVIEW_FINDING_PRIORITIES) {
		const error = validateInteger(priorityCounts[priority], `coverage.findings_by_priority.${priority}`, 0)
		if (error) return error
		priorityTotal += priorityCounts[priority] as number
	}
	if (priorityTotal !== coverage.final_finding_count) {
		return invalidField(
			"coverage.findings_by_priority",
			"coverage.findings_by_priority counts must sum to coverage.final_finding_count.",
		)
	}
	const unique = new Set<string>()
	for (const [index, lens] of coverage.unfinished_lenses.entries()) {
		const error = validateString(lens, `coverage.unfinished_lenses[${index}]`, 64)
		if (error) return error
		if (unique.has(lens)) return invalidField("coverage.unfinished_lenses", "Lens IDs must be unique.")
		unique.add(lens)
	}
	return undefined
}

function createdAt(context: ReviewSubmitContext): string {
	return (context.now?.() ?? new Date()).toISOString().replace(/\.000Z$/, "Z")
}

function outputRoot(context: ReviewSubmitContext): string {
	return context.outputDir
}

function contextRoot(context: ReviewSubmitContext): string {
	return context.contextDir
}

type CheckedPath = { path: string; error?: never } | { path?: never; error: SubmitResult }

function unsafeOutputPath(path: string, detail: string): SubmitResult {
	return rejected("output_path", `Refusing to use ${path}: ${detail}. Output must stay inside review-output.`)
}

async function ensureOutputDirectory(context: ReviewSubmitContext, path: string): Promise<CheckedPath> {
	const checked = await checkReviewDirectory(path, {
		isDefault: context.outputDirIsDefault === true && resolve(path) === resolve(outputRoot(context)),
		projectDir: context.projectDir,
		create: true,
	})
	if (checked.kind === "ready") return { path: checked.path }
	const detail = checked.kind === "unsafe" ? checked.reason : "it is not a real directory and could not be created"
	return { error: unsafeOutputPath(path, detail) }
}

async function readableContextDirectory(context: ReviewSubmitContext): Promise<string | undefined> {
	const checked = await checkReviewDirectory(contextRoot(context), {
		isDefault: context.contextDirIsDefault === true,
		projectDir: context.projectDir,
		create: false,
	})
	return checked.kind === "ready" ? checked.path : undefined
}

async function outputFile(
	context: ReviewSubmitContext,
	kind: "findings" | "summary" | "replies",
): Promise<CheckedPath> {
	const root = outputRoot(context)
	const checkedRoot = await ensureOutputDirectory(context, root)
	if (checkedRoot.error) return checkedRoot
	const checkedDirectory = await ensureOutputDirectory(context, join(checkedRoot.path, kind))
	if (checkedDirectory.error) return checkedDirectory
	if (checkedDirectory.path !== resolve(checkedRoot.path, kind)) {
		return { error: unsafeOutputPath(join(root, kind), "its resolved path escapes review-output") }
	}
	const filePath = join(checkedDirectory.path, `${context.writer}.${kind === "summary" ? "json" : "jsonl"}`)
	try {
		const metadata = await lstat(filePath)
		if (metadata.isSymbolicLink()) return { error: unsafeOutputPath(filePath, "symbolic links are not allowed") }
		if (!metadata.isFile()) return { error: unsafeOutputPath(filePath, "it is not a regular file") }
		const resolvedFile = await realpath(filePath)
		if (dirname(resolvedFile) !== checkedDirectory.path) {
			return { error: unsafeOutputPath(filePath, "its resolved path escapes review-output") }
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { error: unsafeOutputPath(filePath, "it could not be resolved safely") }
		}
	}
	return { path: filePath }
}

async function withWriterLock(context: ReviewSubmitContext, fn: () => Promise<SubmitResult>): Promise<SubmitResult> {
	const checkedRoot = await ensureOutputDirectory(context, outputRoot(context))
	if (checkedRoot.error) return checkedRoot.error
	const lockPath = join(checkedRoot.path, `${context.writer}.lock.sqlite`)
	await context.beforeAcquire?.()
	try {
		return await withSQLiteWriterLock(lockPath, fn, context.beforeRelease)
	} catch (error) {
		if (error instanceof WriterLockUnavailableError) {
			return rejected("lock_unavailable", error.message)
		}
		if (error instanceof WriterLockReleaseError) {
			return rejected(
				"lock_lost",
				`The ${context.writer} writer lock could not be released cleanly; inspect the output before retrying.`,
			)
		}
		return rejected(
			"output_write",
			`The ${context.writer} review output operation failed; no exception escaped the tool.`,
		)
	}
}

async function atomicWrite(context: ReviewSubmitContext, filePath: string, contents: string): Promise<void> {
	const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		handle = await open(temporaryPath, "wx", 0o600)
		await handle.writeFile(contents, "utf8")
		await handle.sync()
		await handle.close()
		handle = undefined
		await context.beforeRename?.()
		await rename(temporaryPath, filePath)
	} finally {
		await handle?.close().catch(() => {})
		await rm(temporaryPath, { force: true }).catch(() => {})
	}
}

async function readBoundedFile(
	filePath: string,
): Promise<{ contents: string; present: boolean; error?: SubmitResult }> {
	try {
		const metadata = await stat(filePath)
		if (metadata.size > MAX_OUTPUT_FILE_BYTES) {
			return {
				contents: "",
				present: true,
				error: rejected("file_too_large", `${filePath} exceeds the ${MAX_OUTPUT_FILE_BYTES}-byte output limit.`, {
					limit: MAX_OUTPUT_FILE_BYTES,
				}),
			}
		}
		return { contents: await readFile(filePath, "utf8"), present: true }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contents: "", present: false }
		throw error
	}
}

function parseExistingRecords(
	contents: string,
	schemaVersion: string,
	writer: string,
): { records: string[]; seq: number } {
	const records: string[] = []
	let expectedSeq = 1
	for (const line of contents.split("\n")) {
		if (line.trim().length === 0) continue
		const record = JSON.parse(line) as Record<string, unknown>
		if (schemaVersion === FINDING_SCHEMA_VERSION) {
			const invalid = validateStoredReviewFinding(record) ?? validateReviewFindingIdentity(record, writer, expectedSeq)
			if (invalid) throw new Error(`existing review output has an invalid finding: ${invalid.message}`)
		} else if (record.schema_version !== schemaVersion || record.writer !== writer || record.seq !== expectedSeq) {
			throw new Error("existing review output has an unsupported schema, writer, or sequence")
		}
		records.push(line)
		expectedSeq += 1
	}
	return { records, seq: expectedSeq }
}

async function appendRecord(
	context: ReviewSubmitContext,
	kind: "findings" | "replies",
	schemaVersion: string,
	buildRecord: (seq: number) => Record<string, unknown>,
	limit: number,
): Promise<SubmitResult> {
	return withWriterLock(context, async () => {
		const destination = await outputFile(context, kind)
		if (destination.error) return destination.error
		const filePath = destination.path
		const existing = await readBoundedFile(filePath)
		if (existing.error) return existing.error
		let parsed: { records: string[]; seq: number }
		try {
			parsed = parseExistingRecords(existing.contents, schemaVersion, context.writer)
		} catch {
			return rejected(
				"output_read",
				`${filePath} is not valid contiguous ${schemaVersion} output; no changes were written.`,
			)
		}
		const count = parsed.records.length
		if (count >= limit) {
			const message =
				kind === "findings"
					? `The writer already has ${count} findings (limit ${limit}); prioritize existing findings instead of adding another.`
					: `The writer already has ${count} replies (limit ${limit}).`
			return rejected("cap", message, { count, limit, ...(kind === "findings" ? { prioritize: true } : {}) })
		}
		const record = buildRecord(parsed.seq)
		const serialized = `${JSON.stringify(record)}\n`
		const contents = `${parsed.records.map((line) => `${line}\n`).join("")}${serialized}`
		if (utf8Length(contents) > MAX_OUTPUT_FILE_BYTES) {
			return rejected("file_too_large", `Appending would exceed the ${MAX_OUTPUT_FILE_BYTES}-byte output limit.`, {
				limit: MAX_OUTPUT_FILE_BYTES,
				count,
			})
		}
		await atomicWrite(context, filePath, contents)
		return accepted(
			`${kind === "findings" ? "Finding" : "Reply"} ${record.id} stored in ${filePath}; nothing was posted.`,
			record.id as string,
			parsed.seq,
		)
	})
}

async function loadCommentableLines(
	context: ReviewSubmitContext,
): Promise<
	| { map?: CommentableLines; absent: true; error?: never }
	| { map: CommentableLines; absent: false; error?: never }
	| { map?: never; absent: false; error: SubmitResult }
> {
	const contextDir = await readableContextDirectory(context)
	// Context that cannot be resolved safely is equivalent to absent context:
	// anchors are not validated, and replies report thread_context_missing.
	if (!contextDir) return { absent: true }
	const filePath = join(contextDir, "commentable-lines.json")
	let raw: unknown
	try {
		raw = JSON.parse(await readFile(filePath, "utf8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { absent: true }
		return {
			absent: false,
			error: rejected("invalid_context", "review-context/commentable-lines.json could not be read as JSON.", {
				field: "commentable-lines.json",
			}),
		}
	}
	if (!raw || typeof raw !== "object") {
		return {
			absent: false,
			error: rejected("invalid_context", "review-context/commentable-lines.json must contain an object.", {
				field: "commentable-lines.json",
			}),
		}
	}
	const map = raw as CommentableLines
	if (map.schema_version !== COMMENTABLE_LINES_SCHEMA_VERSION || !map.files || typeof map.files !== "object") {
		return {
			absent: false,
			error: rejected(
				"invalid_context",
				`review-context/commentable-lines.json must use ${COMMENTABLE_LINES_SCHEMA_VERSION} and contain files.`,
				{ field: "schema_version" },
			),
		}
	}
	const files = Object.values(map.files)
	if (
		files.some((file) => {
			if (file === null || typeof file !== "object" || Array.isArray(file)) return true
			const ranges: unknown = file.ranges
			return (
				ranges !== undefined &&
				(!Array.isArray(ranges) ||
					ranges.some((range) => range === null || typeof range !== "object" || Array.isArray(range)))
			)
		})
	) {
		return {
			absent: false,
			error: rejected(
				"invalid_context",
				"review-context/commentable-lines.json files must be objects whose ranges are arrays of objects.",
				{ field: "files" },
			),
		}
	}
	return { map, absent: false }
}

function rangeDistance(range: CommentableRange, line: number): number {
	if (line < range.start_line) return range.start_line - line
	if (line > range.end_line) return line - range.end_line
	return 0
}

function validRanges(ranges: CommentableRange[] | undefined): CommentableRange[] {
	return (ranges ?? [])
		.filter(
			(range) =>
				Number.isInteger(range.start_line) &&
				Number.isInteger(range.end_line) &&
				range.start_line >= 1 &&
				range.end_line >= range.start_line,
		)
		.sort((left, right) => left.start_line - right.start_line || left.end_line - right.end_line)
}

function anchorError(filePath: string, line: number, file: CommentableFile): SubmitResult {
	const ranges = validRanges(file.ranges)
	if (ranges.length === 0) {
		const fileReason = file.reason ?? "outside_provider_diff"
		return rejected(
			"file_without_anchors",
			`${filePath} cannot take an inline finding (${fileReason}); report it with submit_summary instead.`,
			{ file_reason: fileReason, summary_required: true },
		)
	}
	const nearestRanges = [...ranges]
		.sort((left, right) => rangeDistance(left, line) - rangeDistance(right, line) || left.start_line - right.start_line)
		.slice(0, 10)
		.sort((left, right) => left.start_line - right.start_line || left.end_line - right.end_line)
	const nearest = ranges
		.flatMap((range) => [range.start_line, range.end_line])
		.sort((left, right) => Math.abs(left - line) - Math.abs(right - line) || left - right)[0]
	return rejected(
		"line_outside_hunks",
		`${filePath}:${line} is outside the commentable hunks; nearest valid line ${nearest}. Do not move the finding to an arbitrary line.`,
		{ nearest_valid_line: nearest, ranges: nearestRanges },
	)
}

function validateFindingValues(input: FindingInput): SubmitResult | undefined {
	const pathError = validateString(input.path, "path", 4096)
	if (pathError) return pathError
	for (const field of ["title", "description", "explanation", "suggestion"] as const) {
		const error = validateFindingText(input[field], field)
		if (error) return error
	}
	const lineError = validateInteger(input.line, "line", 1, MAX_CONSUMER_INT32)
	if (lineError) return lineError
	if (!PRIORITIES.has(input.priority)) {
		return invalidField("priority", `priority must be one of ${REVIEW_FINDING_PRIORITIES.join(", ")}.`)
	}
	if (!FINDING_TYPES.has(input.type)) {
		return invalidField("type", `type must be one of ${REVIEW_FINDING_TYPES.join(", ")}.`)
	}
	if (input.derived_from !== undefined) {
		if (!Array.isArray(input.derived_from) || input.derived_from.length > MAX_DERIVED_FROM_IDS) {
			return invalidField(
				"derived_from",
				`derived_from accepts at most ${MAX_DERIVED_FROM_IDS} IDs.`,
				MAX_DERIVED_FROM_IDS,
			)
		}
		for (const [index, id] of input.derived_from.entries()) {
			const error = validateString(id, `derived_from[${index}]`, 256, { allowEmpty: false })
			if (error) return error
		}
	}
	return undefined
}

/** Strict field validation shared by submit tools, candidate ingest, and final output. */
export function validateReviewFindingFields(input: FindingInput): SubmitResult | undefined {
	const unknownField = validateFields(input as unknown as Record<string, unknown>, FINDING_FIELDS)
	if (unknownField) return unknownField
	return validateFindingValues(input)
}

/** Validate a complete persisted record while excluding no bookkeeping fields. */
export function validateStoredReviewFinding(input: Record<string, unknown>): SubmitResult | undefined {
	const unknownField = validateFields(input, FINDING_RECORD_FIELDS)
	if (unknownField) return unknownField
	return validateFindingValues(input as unknown as FindingInput)
}

function isReviewFindingTimestamp(value: unknown): boolean {
	if (typeof value !== "string" || value.length > 64) return false
	const dateTime = UTC_TIMESTAMP_PATTERN.exec(value)?.[1]?.toUpperCase()
	if (!dateTime) return false
	const date = new Date(`${dateTime}Z`)
	// Date normalizes some out-of-range components instead of rejecting them.
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === dateTime
}

/** Validate schema, writer, sequence, matching ID, and timestamp for a stored finding. */
export function validateReviewFindingIdentity(
	input: Record<string, unknown>,
	writer: string,
	expectedSeq: number,
): SubmitResult | undefined {
	if (input.schema_version !== FINDING_SCHEMA_VERSION) {
		return invalidField("schema_version", `schema_version must be ${FINDING_SCHEMA_VERSION}.`)
	}
	if (input.writer !== writer) return invalidField("writer", `writer must be ${writer}.`)
	if (input.seq !== expectedSeq) return invalidField("seq", `seq must be ${expectedSeq}.`)
	if (input.id !== `${writer}-${expectedSeq}`) {
		return invalidField("id", `id must be ${writer}-${expectedSeq}.`)
	}
	if (!isReviewFindingTimestamp(input.created_at)) {
		return invalidField("created_at", "created_at must be an RFC 3339 UTC timestamp of at most 64 bytes.")
	}
	return undefined
}

export function capReviewFindingPriority(
	priority: ReviewFindingPriority,
	type: ReviewFindingType,
): ReviewFindingPriority {
	if (type === "convention" || type === "docs") return "P4"
	if (type === "test-gap" && (priority === "P0" || priority === "P1" || priority === "P2")) return "P3"
	return priority
}

/** Revalidate finding fields and the original snapshot's anchors without
 * writing output. The panel uses this for writer-file ingest and semantic output. */
export async function validateReviewFindingInput(
	input: FindingInput,
	context: ReviewSubmitContext,
): Promise<SubmitResult | undefined> {
	const invalidFields = validateReviewFindingFields(input)
	if (invalidFields) return invalidFields
	const loaded = await loadCommentableLines(context)
	if (loaded.error) return loaded.error
	if (!loaded.absent) {
		const file = loaded.map.files[input.path] ?? { reason: "outside_provider_diff" }
		const ranges = validRanges(file.ranges)
		if (!ranges.some((range) => input.line >= range.start_line && input.line <= range.end_line)) {
			return anchorError(input.path, input.line, file)
		}
	}
	return undefined
}

export async function submitFinding(input: FindingInput, context: ReviewSubmitContext): Promise<SubmitResult> {
	const writerError = validateWriter(context.writer)
	if (writerError) return writerError
	const invalid = await validateReviewFindingInput(input, context)
	if (invalid) return invalid

	const limit = context.writer === "final" ? DEFAULT_WRITER_LIMIT : (context.writerLimit ?? DEFAULT_WRITER_LIMIT)
	const normalized = normalizeFindingInput(input)
	return appendRecord(
		context,
		"findings",
		FINDING_SCHEMA_VERSION,
		(seq) => {
			const id = `${context.writer}-${seq}`
			return {
				schema_version: FINDING_SCHEMA_VERSION,
				id,
				writer: context.writer,
				seq,
				created_at: createdAt(context),
				path: normalized.path,
				line: normalized.line,
				title: normalized.title,
				description: normalized.description,
				explanation: normalized.explanation,
				suggestion: normalized.suggestion,
				priority: normalized.priority,
				type: normalized.type,
				...(normalized.derived_from === undefined ? {} : { derived_from: normalized.derived_from }),
			}
		},
		limit,
	)
}

export async function submitSummary(input: SummaryInput, context: ReviewSubmitContext): Promise<SubmitResult> {
	const writerError = validateWriter(context.writer)
	if (writerError) return writerError
	const unknownField = validateFields(input as unknown as Record<string, unknown>, SUMMARY_FIELDS)
	if (unknownField) return unknownField
	const bodyError = validateString(input.body, "body", MAX_SUMMARY_BODY_BYTES, { allowEmpty: true })
	if (bodyError) return bodyError
	const coverageError = validateCoverage(input.coverage)
	if (coverageError) return coverageError
	for (const [field, minimum, maximum] of [
		["score", 0, 100],
		["estimated_effort_to_review", 1, 5],
	] as const) {
		if (input[field] !== undefined) {
			const error = validateInteger(input[field], field, minimum, maximum)
			if (error) return error
		}
	}
	const gaps = input.environment_gaps ?? []
	if (!Array.isArray(gaps) || gaps.length > 50) {
		return invalidField("environment_gaps", "environment_gaps accepts at most 50 entries.", 50)
	}
	for (const [index, gap] of gaps.entries()) {
		if (!gap || typeof gap !== "object")
			return invalidField(`environment_gaps[${index}]`, "Environment gap must be an object.")
		const unknownGapField = validateFields(gap as unknown as Record<string, unknown>, ["kind", "name", "note"])
		if (unknownGapField) return unknownGapField
		for (const [field, limit] of [
			["kind", 64],
			["name", 512],
			["note", 2048],
		] as const) {
			const error = validateString(gap[field], `environment_gaps[${index}].${field}`, limit, {
				allowEmpty: field === "note",
			})
			if (error) return error
		}
	}

	return withWriterLock(context, async () => {
		const destination = await outputFile(context, "summary")
		if (destination.error) return destination.error
		const filePath = destination.path
		const record: ReviewSummaryRecord = {
			schema_version: SUMMARY_SCHEMA_VERSION,
			writer: context.writer,
			created_at: createdAt(context),
			body: input.body,
			...(input.score === undefined ? {} : { score: input.score }),
			...(input.estimated_effort_to_review === undefined
				? {}
				: { estimated_effort_to_review: input.estimated_effort_to_review }),
			environment_gaps: gaps,
			...(input.coverage === undefined ? {} : { coverage: input.coverage }),
		}
		const contents = `${JSON.stringify(record, null, 2)}\n`
		if (utf8Length(contents) > MAX_OUTPUT_FILE_BYTES) {
			return rejected("file_too_large", `The summary exceeds the ${MAX_OUTPUT_FILE_BYTES}-byte output limit.`, {
				limit: MAX_OUTPUT_FILE_BYTES,
			})
		}
		await atomicWrite(context, filePath, contents)
		return accepted(`Summary for ${context.writer} stored in ${filePath}; nothing was posted.`)
	})
}

async function loadThreads(context: ReviewSubmitContext): Promise<{ threads?: ReviewThread[]; error?: SubmitResult }> {
	const contextDir = await readableContextDirectory(context)
	if (!contextDir) {
		return {
			error: rejected(
				"thread_context_missing",
				"review-context/comments.json is absent or unavailable; submit_reply requires safe existing thread context. No reply was written.",
				{ field: "thread_id" },
			),
		}
	}
	const filePath = join(contextDir, "comments.json")
	let raw: unknown
	try {
		raw = JSON.parse(await readFile(filePath, "utf8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				error: rejected(
					"thread_context_missing",
					"review-context/comments.json is absent; submit_reply requires existing thread context. No reply was written.",
					{ field: "thread_id" },
				),
			}
		}
		return {
			error: rejected("invalid_context", "review-context/comments.json could not be read as JSON.", {
				field: "comments.json",
			}),
		}
	}
	const invalidCommentsContext = (field: string, detail: string): { error: SubmitResult } => ({
		error: rejected("invalid_context", `review-context/comments.json is invalid: ${detail}.`, { field }),
	})
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return invalidCommentsContext("comments.json", "expected a versioned object with a threads array")
	}
	const document = raw as { schema_version?: unknown; threads?: unknown }
	if (document.schema_version !== COMMENTS_SCHEMA_VERSION) {
		return invalidCommentsContext("schema_version", `expected ${COMMENTS_SCHEMA_VERSION}`)
	}
	if (!Array.isArray(document.threads)) return invalidCommentsContext("threads", "expected an array")
	for (const [index, thread] of document.threads.entries()) {
		if (thread === null || typeof thread !== "object" || Array.isArray(thread)) {
			return invalidCommentsContext(`threads[${index}]`, "expected an object")
		}
		const candidate = thread as Record<string, unknown>
		if (
			typeof candidate.thread_id !== "string" ||
			candidate.thread_id.length === 0 ||
			candidate.thread_id.includes("\0") ||
			utf8Length(candidate.thread_id) > 256
		) {
			return invalidCommentsContext(`threads[${index}].thread_id`, "expected a non-empty string of at most 256 bytes")
		}
		if (typeof candidate.is_ours !== "boolean") {
			return invalidCommentsContext(`threads[${index}].is_ours`, "expected a boolean")
		}
		if (typeof candidate.mentions_bot !== "boolean") {
			return invalidCommentsContext(`threads[${index}].mentions_bot`, "expected a boolean")
		}
	}
	return { threads: document.threads as ReviewThread[] }
}

/** Validate reply fields, verdict support, and the producer-supplied thread
 * scope without creating or changing output. */
export async function validateReviewReplyInput(
	input: ReplyInput,
	context: ReviewSubmitContext,
): Promise<SubmitResult | undefined> {
	// Missing context is the decisive failure on a first review: every reply is
	// rejected before field validation or output creation.
	const loaded = await loadThreads(context)
	if (loaded.error) return loaded.error
	const unknownField = validateFields(input as unknown as Record<string, unknown>, REPLY_FIELDS)
	if (unknownField) return unknownField
	const threadError = validateString(input.thread_id, "thread_id", 256)
	if (threadError) return threadError
	const bodyError = validateString(input.body, "body", 64 * 1024)
	if (bodyError) return bodyError
	if (!ACTIONS.has(input.action)) return invalidField("action", "action must be resolve, reopen, or none.")
	if (input.verdict !== undefined && !VERDICTS.has(input.verdict)) {
		return invalidField("verdict", "verdict is not a supported review verdict.")
	}
	if (input.evidence_kind !== undefined && !EVIDENCE_KINDS.has(input.evidence_kind)) {
		return invalidField("evidence_kind", "evidence_kind is not a supported evidence kind.")
	}
	if (input.evidence !== undefined) {
		const evidenceError = validateString(input.evidence, "evidence", 16 * 1024, { allowEmpty: true })
		if (evidenceError) return evidenceError
	}

	const thread = (loaded.threads ?? []).find((candidate) => candidate.thread_id === input.thread_id)
	if (!thread) {
		return rejected("thread_not_found", `Thread ${input.thread_id} is not present in review-context/comments.json.`, {
			field: "thread_id",
		})
	}
	const ours = thread.is_ours
	if (!ours && !thread.mentions_bot) {
		return rejected(
			"thread_out_of_scope",
			"Replies are limited to our own findings and threads that explicitly mention the bot; other threads are read-only context.",
			{ field: "thread_id" },
		)
	}
	if (!ours && input.action !== "none") {
		return rejected(
			"thread_action_forbidden",
			"Only our own threads may be resolved or reopened; use action none here.",
			{
				field: "action",
			},
		)
	}
	if (ours) {
		if (input.verdict === undefined)
			return invalidField("verdict", "verdict is required for a thread on one of our findings.")
		if (input.evidence_kind === undefined) {
			return invalidField("evidence_kind", "evidence_kind is required for a thread on one of our findings.")
		}
		if (input.evidence === undefined) {
			return invalidField(
				"evidence",
				"evidence is required for a thread on one of our findings; use an empty string when absent.",
			)
		}
	}

	return undefined
}

export async function submitReply(input: ReplyInput, context: ReviewSubmitContext): Promise<SubmitResult> {
	const writerError = validateWriter(context.writer)
	if (writerError) return writerError
	const invalid = await validateReviewReplyInput(input, context)
	if (invalid) return invalid
	return appendRecord(
		context,
		"replies",
		REPLY_SCHEMA_VERSION,
		(seq) => ({
			schema_version: REPLY_SCHEMA_VERSION,
			id: `${context.writer}-${seq}`,
			writer: context.writer,
			seq,
			created_at: createdAt(context),
			thread_id: input.thread_id,
			body: input.body,
			action: input.action,
			...(input.verdict === undefined ? {} : { verdict: input.verdict }),
			...(input.evidence_kind === undefined ? {} : { evidence_kind: input.evidence_kind }),
			...(input.evidence === undefined ? {} : { evidence: input.evidence }),
		}),
		REPLY_LIMIT,
	)
}
