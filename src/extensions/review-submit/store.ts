import { randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { WriterLockReleaseError, WriterLockUnavailableError, withSQLiteWriterLock } from "./sqlite-lock.js"

export const FINDING_SCHEMA_VERSION = "review-finding/v1"
export const SUMMARY_SCHEMA_VERSION = "review-summary/v1"
export const REPLY_SCHEMA_VERSION = "review-reply/v1"
export const MAX_OUTPUT_FILE_BYTES = 1 << 20
export const DEFAULT_WRITER_LIMIT = 50
export const REPLY_LIMIT = 30

const COMMENTABLE_LINES_SCHEMA_VERSION = "commentable-lines/v1"
const COMMENTS_SCHEMA_VERSION = "review-comments/v1"
const MAX_CONSUMER_INT32 = 2_147_483_647
const WRITER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TYPE_PATTERN = /^[a-z][a-z0-9_]*$/

const FINDING_FIELDS = ["path", "line", "severity", "type", "description", "suggestion", "derived_from"]
const SUMMARY_FIELDS = ["body", "score", "estimated_effort_to_review", "environment_gaps"]
const REPLY_FIELDS = ["thread_id", "body", "action", "verdict", "evidence_kind", "evidence"]
const SEVERITIES = new Set(["critical", "warning", "info"])
const ACTIONS = new Set(["resolve", "reopen", "none"])
const VERDICTS = new Set(["fixed", "not_fixed", "partially_fixed", "no_longer_applicable", "regressed", "unverified"])
const EVIDENCE_KINDS = new Set(["code_reference", "existing_test", "new_test", "none"])

interface FindingInput {
	path: string
	line: number
	severity: string
	type: string
	description: string
	suggestion: string
	derived_from?: string[]
}

interface EnvironmentGap {
	kind: string
	name: string
	note: string
}

interface SummaryInput {
	body: string
	score?: number
	estimated_effort_to_review?: number
	environment_gaps?: EnvironmentGap[]
}

interface ReplyInput {
	thread_id: string
	body: string
	action: string
	verdict?: string
	evidence_kind?: string
	evidence?: string
}

export interface ReviewSubmitContext {
	homeDir: string
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

function validateFields(input: Record<string, unknown>, allowed: string[]): SubmitResult | undefined {
	for (const field of Object.keys(input)) {
		if (!allowed.includes(field)) return invalidField(field, `${field} is not an accepted field.`)
	}
	return undefined
}

function validateWriter(writer: string): SubmitResult | undefined {
	if (!WRITER_PATTERN.test(writer)) {
		return rejected("invalid_writer", "REVIEW_WRITER must contain only letters, digits, underscores, or hyphens.", {
			field: "writer",
		})
	}
	return undefined
}

function createdAt(context: ReviewSubmitContext): string {
	return (context.now?.() ?? new Date()).toISOString().replace(/\.000Z$/, "Z")
}

function outputRoot(context: ReviewSubmitContext): string {
	return join(context.homeDir, "review-output")
}

function contextRoot(context: ReviewSubmitContext): string {
	return join(context.homeDir, "review-context")
}

type CheckedPath = { path: string; error?: never } | { path?: never; error: SubmitResult }

function unsafeOutputPath(path: string, detail: string): SubmitResult {
	return rejected("output_path", `Refusing to use ${path}: ${detail}. Output must stay inside review-output.`)
}

async function ensureOutputDirectory(path: string): Promise<CheckedPath> {
	try {
		let metadata: Stats
		try {
			metadata = await lstat(path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			try {
				await mkdir(path, { mode: 0o700 })
			} catch (error) {
				// A concurrent creator won the mkdir race; lstat below decides
				// whether it made a real directory or a symlink/non-directory.
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			}
			metadata = await lstat(path)
		}
		if (metadata.isSymbolicLink()) return { error: unsafeOutputPath(path, "symbolic links are not allowed") }
		if (!metadata.isDirectory()) return { error: unsafeOutputPath(path, "it is not a directory") }
		return { path: await realpath(path) }
	} catch {
		return { error: unsafeOutputPath(path, "the directory could not be created or resolved") }
	}
}

async function outputFile(
	context: ReviewSubmitContext,
	kind: "findings" | "summary" | "replies",
): Promise<CheckedPath> {
	const root = outputRoot(context)
	const checkedRoot = await ensureOutputDirectory(root)
	if (checkedRoot.error) return checkedRoot
	const checkedDirectory = await ensureOutputDirectory(join(checkedRoot.path, kind))
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
	const checkedRoot = await ensureOutputDirectory(outputRoot(context))
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
		const record = JSON.parse(line) as { schema_version?: string; writer?: string; seq?: number }
		if (record.schema_version !== schemaVersion || record.writer !== writer || record.seq !== expectedSeq) {
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
	const filePath = join(contextRoot(context), "commentable-lines.json")
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

export async function submitFinding(input: FindingInput, context: ReviewSubmitContext): Promise<SubmitResult> {
	const writerError = validateWriter(context.writer)
	if (writerError) return writerError
	const unknownField = validateFields(input as unknown as Record<string, unknown>, FINDING_FIELDS)
	if (unknownField) return unknownField
	for (const [field, limit, allowEmpty] of [
		["path", 4096, false],
		["type", 64, false],
		["description", 16 * 1024, false],
		["suggestion", 16 * 1024, true],
	] as const) {
		const error = validateString(input[field], field, limit, { required: true, allowEmpty })
		if (error) return error
	}
	if (!TYPE_PATTERN.test(input.type)) return invalidField("type", "type must match ^[a-z][a-z0-9_]*$.")
	const lineError = validateInteger(input.line, "line", 1, MAX_CONSUMER_INT32)
	if (lineError) return lineError
	if (!SEVERITIES.has(input.severity)) return invalidField("severity", "severity must be critical, warning, or info.")
	if (input.derived_from !== undefined) {
		if (!Array.isArray(input.derived_from) || input.derived_from.length > 50) {
			return invalidField("derived_from", "derived_from accepts at most 50 IDs.", 50)
		}
		for (const [index, id] of input.derived_from.entries()) {
			const error = validateString(id, `derived_from[${index}]`, 256, { allowEmpty: false })
			if (error) return error
		}
	}

	const loaded = await loadCommentableLines(context)
	if (loaded.error) return loaded.error
	if (!loaded.absent) {
		const file = loaded.map.files[input.path] ?? { reason: "outside_provider_diff" }
		const ranges = validRanges(file.ranges)
		if (!ranges.some((range) => input.line >= range.start_line && input.line <= range.end_line)) {
			return anchorError(input.path, input.line, file)
		}
	}

	const limit = context.writer === "final" ? DEFAULT_WRITER_LIMIT : (context.writerLimit ?? DEFAULT_WRITER_LIMIT)
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
				path: input.path,
				line: input.line,
				severity: input.severity,
				type: input.type,
				description: input.description,
				suggestion: input.suggestion,
				...(input.derived_from === undefined ? {} : { derived_from: input.derived_from }),
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
	const bodyError = validateString(input.body, "body", 64 * 1024, { allowEmpty: true })
	if (bodyError) return bodyError
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
		const record = {
			schema_version: SUMMARY_SCHEMA_VERSION,
			writer: context.writer,
			created_at: createdAt(context),
			body: input.body,
			...(input.score === undefined ? {} : { score: input.score }),
			...(input.estimated_effort_to_review === undefined
				? {}
				: { estimated_effort_to_review: input.estimated_effort_to_review }),
			environment_gaps: gaps,
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
	const filePath = join(contextRoot(context), "comments.json")
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

export async function submitReply(input: ReplyInput, context: ReviewSubmitContext): Promise<SubmitResult> {
	const writerError = validateWriter(context.writer)
	if (writerError) return writerError
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
