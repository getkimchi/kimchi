import { createHash } from "node:crypto"

declare const Temporal: {
	Instant: {
		from(value: string): {
			readonly epochNanoseconds: bigint
			toString(): string
			toZonedDateTimeISO(offset: string): {
				toString(options: { timeZoneName: "never"; calendarName: "never" }): string
			}
		}
	}
}

// Field order and omission rules match Kubecast prcostprotocol; native v1 bytes are frozen.
export const Version = 1
const ZeroTime = "0001-01-01T00:00:00Z"
export interface Repository {
	provider: string
	host: string
	id: string
	name?: string
}
export interface RawUsage {
	inputTokens?: string
	outputTokens?: string
	cacheReadTokens?: string
	cacheWriteTokens?: string
	cacheWrites?: CacheWrite[]
	reasoningTokens?: string
}
export interface CacheWrite {
	ttlSeconds: number
	tokens: string
}
export interface IssueKey {
	key: string
	source: string
	revision?: string
}
export interface RequestAlias {
	namespace: string
	id: string
	source: string
}
export interface Credit {
	amount: string
	unit: string
	basis: string
}
export interface Iteration {
	id: string
	model?: string
	schema: string
	raw: RawUsage
	stopReason?: string
	billingStatus?: string
}
export interface Usage {
	channel: string
	requestId?: string
	responseId?: string
	schema: string
	counterScope: string
	observedRoute: string
	reportedModel?: string
	actualModel?: string
	provider?: string
	serviceTier?: string
	region?: string
	billingBasis: string
	correlation: string
	raw: RawUsage
	iterations?: Iteration[]
	finalIterationId?: string
	attemptsComplete: boolean
	stopReason?: string
	billingStatus?: string
	durationMs?: string
	credits?: Credit[]
	aliases?: RequestAlias[]
}
export interface Work {
	title?: string
	planId?: string
	planRevision?: string
	reason: string
	quality: string
	issueKeys?: IssueKey[]
}
export interface Tool {
	callId: string
	name?: string
	requestEntityId?: string
	category: string
	outcome: string
	durationMs?: string
}
export interface File {
	fileId: string
	toolCallId?: string
	beforeRevision?: string
	afterRevision?: string
	operation: string
	quality: string
}
export interface Commit {
	id: string
	parents?: string[]
	quality: string
}
export interface PullRequest {
	id: string
	number: number
	uri: string
	state: string
	createTime?: string
	closeTime?: string
	mergeTime?: string
	mergeCommitId?: string
	title?: string
	issueKeys?: IssueKey[]
}
export interface Link {
	fromKind: string
	fromId: string
	toKind: string
	toId: string
	quality: string
	reason: string
}
export interface Coverage {
	code: string
	count: string
	windowStartTime?: string
	windowEndTime?: string
	observedUsage?: RawUsage
	model?: string
}
export interface Allocation {
	kind: string
	pullRequestIds?: string[]
	method: string
}
export interface Correction {
	id: string
	revision: number
	recordedAt: string
	source: string
}
export interface Event {
	id: string
	entityId: string
	revision: string
	baseRevision?: string
	baseHash?: string
	source: string
	sourceVersion: string
	deviceId: string
	observeTime: string
	repository?: Repository
	workId?: string
	sessionId?: string
	turnId?: string
	agentId?: string
	work?: Work
	usage?: Usage
	tool?: Tool
	file?: File
	commit?: Commit
	pullRequest?: PullRequest
	link?: Link
	coverage?: Coverage
	allocation?: Allocation
	claimState?: string
	correction?: Correction
	startedAt?: string
}
export interface Batch {
	version: number
	id: string
	events: Event[]
}
export interface Receipt {
	id: string
	status: string
	revision: string
}
export interface Acknowledgement {
	batchId: string
	receiveTime?: string
	generation?: string
	receipts: Receipt[]
}

type Field = readonly [name: string, type: string, omit?: "empty" | "nil"]
const schemas: Record<string, readonly Field[]> = {
	repository: [
		["provider", "s"],
		["host", "s"],
		["id", "s"],
		["name", "s", "empty"],
	],
	issue: [
		["key", "s"],
		["source", "s"],
		["revision", "q", "empty"],
	],
	work: [
		["title", "s", "empty"],
		["planId", "s", "empty"],
		["planRevision", "s", "empty"],
		["reason", "s"],
		["quality", "s"],
		["issueKeys", "[]issue", "empty"],
	],
	raw: [
		["inputTokens", "q", "nil"],
		["outputTokens", "q", "nil"],
		["cacheReadTokens", "q", "nil"],
		["cacheWriteTokens", "q", "nil"],
		["cacheWrites", "[]cacheWrite", "empty"],
		["reasoningTokens", "q", "nil"],
	],
	cacheWrite: [
		["ttlSeconds", "i32"],
		["tokens", "q"],
	],
	iteration: [
		["id", "s"],
		["model", "s", "empty"],
		["schema", "s"],
		["raw", "raw"],
		["stopReason", "s", "empty"],
		["billingStatus", "s", "empty"],
	],
	credit: [
		["amount", "s"],
		["unit", "s"],
		["basis", "s"],
	],
	alias: [
		["namespace", "s"],
		["id", "s"],
		["source", "s"],
	],
	usage: [
		["channel", "s"],
		["requestId", "s", "empty"],
		["responseId", "s", "empty"],
		["schema", "s"],
		["counterScope", "s"],
		["observedRoute", "s"],
		["reportedModel", "s", "empty"],
		["actualModel", "s", "empty"],
		["provider", "s", "empty"],
		["serviceTier", "s", "empty"],
		["region", "s", "empty"],
		["billingBasis", "s"],
		["correlation", "s"],
		["raw", "raw"],
		["iterations", "[]iteration", "empty"],
		["finalIterationId", "s", "empty"],
		["attemptsComplete", "b"],
		["stopReason", "s", "empty"],
		["billingStatus", "s", "empty"],
		["durationMs", "q", "nil"],
		["credits", "[]credit", "empty"],
		["aliases", "[]alias", "empty"],
	],
	tool: [
		["callId", "s"],
		["name", "s", "empty"],
		["requestEntityId", "s", "empty"],
		["category", "s"],
		["outcome", "s"],
		["durationMs", "q", "empty"],
	],
	file: [
		["fileId", "s"],
		["toolCallId", "s", "empty"],
		["beforeRevision", "s", "empty"],
		["afterRevision", "s", "empty"],
		["operation", "s"],
		["quality", "s"],
	],
	commit: [
		["id", "s"],
		["parents", "[]s", "empty"],
		["quality", "s"],
	],
	pullRequest: [
		["id", "s"],
		["number", "i32"],
		["uri", "s"],
		["state", "s"],
		["createTime", "t", "nil"],
		["closeTime", "t", "nil"],
		["mergeTime", "t", "nil"],
		["mergeCommitId", "s", "empty"],
		["title", "s", "empty"],
		["issueKeys", "[]issue", "empty"],
	],
	link: [
		["fromKind", "s"],
		["fromId", "s"],
		["toKind", "s"],
		["toId", "s"],
		["quality", "s"],
		["reason", "s"],
	],
	coverage: [
		["code", "s"],
		["count", "q"],
		["windowStartTime", "t", "nil"],
		["windowEndTime", "t", "nil"],
		["observedUsage", "raw", "nil"],
		["model", "s", "empty"],
	],
	allocation: [
		["kind", "s"],
		["pullRequestIds", "[]s", "empty"],
		["method", "s"],
	],
	correction: [
		["id", "s"],
		["revision", "i32"],
		["recordedAt", "t"],
		["source", "s"],
	],
	event: [
		["id", "s"],
		["entityId", "s"],
		["revision", "q"],
		["baseRevision", "q", "empty"],
		["baseHash", "s", "empty"],
		["source", "s"],
		["sourceVersion", "s"],
		["deviceId", "s"],
		["observeTime", "t"],
		["repository", "repository", "nil"],
		["workId", "s", "empty"],
		["sessionId", "s", "empty"],
		["turnId", "s", "empty"],
		["agentId", "s", "empty"],
		["work", "work", "nil"],
		["usage", "usage", "nil"],
		["tool", "tool", "nil"],
		["file", "file", "nil"],
		["commit", "commit", "nil"],
		["pullRequest", "pullRequest", "nil"],
		["link", "link", "nil"],
		["coverage", "coverage", "nil"],
		["allocation", "allocation", "nil"],
		["claimState", "s", "empty"],
		["correction", "correction", "nil"],
		["startedAt", "t", "nil"],
	],
	batch: [
		["version", "n"],
		["id", "s"],
		["events", "[]event"],
	],
}

/** Production is Bun, as for the ledger; Temporal preserves Go's nanosecond timestamps and numeric offsets. */
export function canonicalTime(value: string | Date): string {
	const text = value instanceof Date ? value.toISOString() : value
	const instant = Temporal.Instant.from(text)
	const offset = text.endsWith("Z") ? "Z" : text.slice(-6)
	const result =
		offset === "Z" || offset === "+00:00" || offset === "-00:00"
			? instant.toString()
			: instant.toZonedDateTimeISO(offset).toString({ timeZoneName: "never", calendarName: "never" })
	if (result[4] !== "-") throw new TypeError("Invalid wire year")
	return result
}

export function timeNanos(value: string): bigint {
	return Temporal.Instant.from(value).epochNanoseconds
}

/** The generated ingestion API normalizes protobuf timestamps before computing its stored hashes. */
export function normalizeIngestTimes(event: Event): Event {
	const utc = (value: string): string => {
		const text = Temporal.Instant.from(value).toString()
		if (text[4] !== "-" || text.startsWith("0000-")) throw new TypeError("Invalid protobuf timestamp year")
		return text
	}
	const normalized = { ...event, observeTime: utc(event.observeTime) }
	if (event.startedAt != null) normalized.startedAt = utc(event.startedAt)
	if (event.correction) normalized.correction = { ...event.correction, recordedAt: utc(event.correction.recordedAt) }
	if (event.coverage) {
		normalized.coverage = { ...event.coverage }
		if (event.coverage.windowStartTime != null)
			normalized.coverage.windowStartTime = utc(event.coverage.windowStartTime)
		if (event.coverage.windowEndTime != null) normalized.coverage.windowEndTime = utc(event.coverage.windowEndTime)
	}
	if (event.pullRequest) {
		normalized.pullRequest = { ...event.pullRequest }
		if (event.pullRequest.createTime != null) normalized.pullRequest.createTime = utc(event.pullRequest.createTime)
		if (event.pullRequest.closeTime != null) normalized.pullRequest.closeTime = utc(event.pullRequest.closeTime)
		if (event.pullRequest.mergeTime != null) normalized.pullRequest.mergeTime = utc(event.pullRequest.mergeTime)
	}
	return normalized
}

function shape(name: string, value: unknown): Record<string, unknown> {
	if (value != null && (typeof value !== "object" || Array.isArray(value))) throw new TypeError("Invalid wire object")
	const object = (value ?? {}) as Record<string, unknown>
	const result: Record<string, unknown> = {}
	for (const [key, type, omit] of schemas[name]) {
		const input = object[key]
		if (omit && input == null) continue
		const converted = convert(type, input)
		if (
			omit === "empty" &&
			(converted === "" ||
				converted === false ||
				converted === 0 ||
				(type === "q" && converted === "0") ||
				(Array.isArray(converted) && !converted.length))
		)
			continue
		result[key] = converted
	}
	return result
}

function convert(type: string, value: unknown): unknown {
	if (type.startsWith("[]")) {
		if (value == null) return null
		if (!Array.isArray(value)) throw new TypeError("Invalid wire array")
		return value.map((entry) => convert(type.slice(2), entry))
	}
	if (type === "s") {
		if (value == null) return ""
		if (typeof value !== "string") throw new TypeError("Invalid wire string")
		return value
	}
	if (type === "q") {
		if (value == null) return "0"
		if (typeof value !== "string") throw new TypeError("Invalid wire int64")
		const digits = value.startsWith("-") ? value.slice(1) : value
		if (!digits.length || !Array.from(digits).every((character) => character >= "0" && character <= "9"))
			throw new TypeError("Invalid wire int64")
		const integer = BigInt(value)
		if (integer < -(1n << 63n) || integer >= 1n << 63n) throw new TypeError("Invalid wire int64")
		return integer.toString()
	}
	if (type === "n" || type === "i32") {
		if (value == null) return 0
		if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError("Invalid wire integer")
		if (type === "i32" && (value < -2147483648 || value > 2147483647)) throw new TypeError("Invalid wire int32")
		return value
	}
	if (type === "b") {
		if (value == null) return false
		if (typeof value !== "boolean") throw new TypeError("Invalid wire boolean")
		return value
	}
	if (type === "t") {
		if (value != null && typeof value !== "string" && !(value instanceof Date)) throw new TypeError("Invalid wire time")
		return canonicalTime(value ?? ZeroTime)
	}
	return shape(type, value)
}

function encode(value: unknown): string {
	return JSON.stringify(value, (_key, entry) =>
		typeof entry === "string" ? Buffer.from(entry).toString("utf8") : entry,
	)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029")
}

export function encodeEvent(event: Event): string {
	return encode(shape("event", event))
}
export function encodeBatch(batch: Batch): string {
	return encode(shape("batch", batch))
}
export function eventHash(event: Event): string {
	return createHash("sha256").update(encodeEvent(event)).digest("hex")
}
export function batchHash(batch: Batch): string {
	return createHash("sha256").update(encodeBatch(batch)).digest("hex")
}
export function stableID(...parts: string[]): string {
	const hash = createHash("sha256").update(encode(parts)).digest("hex").slice(0, 32)
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`
}

function uuidBytes(value: string): Buffer | undefined {
	const parts = value.split("-")
	if (parts.map((part) => part.length).join(",") !== "8,4,4,4,12") return undefined
	const compact = parts.join("").toLowerCase()
	const bytes = Buffer.from(compact, "hex")
	return bytes.length === 16 && bytes.toString("hex") === compact ? bytes : undefined
}

function nonzeroUUID(value: string): boolean {
	return uuidBytes(value)?.some((byte) => byte !== 0) ?? false
}

function validateClaimEvidence(event: Event, invalid: () => never): void {
	if (event.claimState && !["active", "retracted"].includes(event.claimState)) invalid()
	const allocation = event.allocation
	if (allocation) {
		const ids = allocation.pullRequestIds ?? []
		if (
			!["pull-request", "unmerged", "post-merge", "shared", "unlinked", "unknown"].includes(allocation.kind) ||
			!["native", "explicit", "user-correction", "model", "session"].includes(allocation.method) ||
			ids.length > 250 ||
			ids.some((id) => !id || !opaque(id)) ||
			new Set(ids).size !== ids.length ||
			(["pull-request", "unmerged", "post-merge"].includes(allocation.kind) && ids.length !== 1) ||
			(allocation.kind === "shared" && ids.length < 2) ||
			(allocation.kind === "unlinked" && ids.length !== 0)
		)
			invalid()
	}
	if (event.correction) {
		const correction = event.correction
		const at = Temporal.Instant.from(correction.recordedAt).epochNanoseconds
		if (
			!nonzeroUUID(correction.id) ||
			correction.revision < 1 ||
			!["work-command", "producer-confirmation"].includes(correction.source) ||
			at < 0n ||
			at >= Temporal.Instant.from("2200-01-01T00:00:00Z").epochNanoseconds
		)
			invalid()
	}
	if (event.startedAt) {
		const at = Temporal.Instant.from(event.startedAt).epochNanoseconds
		if (at < 0n || at > Temporal.Instant.from(event.observeTime).epochNanoseconds + 600_000_000_000n) invalid()
	}
	if (
		event.source === "kimchi" &&
		event.usage?.counterScope === "request" &&
		(event.allocation || event.claimState || event.correction || event.startedAt) &&
		!nonzeroUUID(event.usage.requestId ?? "")
	)
		invalid()
}
const payloads = ["work", "usage", "tool", "file", "commit", "pullRequest", "link", "coverage"] as const
export function eventKind(e: Event): string {
	const key = payloads.find((k) => e[k] != null)
	return key === "pullRequest" ? "pull_request" : (key ?? "")
}
const containsAny = (text: string, characters: string) =>
	Array.from(characters).some((character) => text.includes(character))
const digit = (character: string) => character >= "0" && character <= "9"
function bounded(value: unknown, maximum: number): boolean {
	const text = value ?? ""
	return (
		typeof text === "string" &&
		Buffer.byteLength(text) <= maximum &&
		!Array.from(text).some((character) => {
			const code = character.charCodeAt(0)
			return code <= 31 || (code >= 127 && code <= 159)
		})
	)
}
function opaque(value: unknown): boolean {
	const text = value ?? ""
	return typeof text === "string" && bounded(text, 128) && !containsAny(text, "/\\@?#|")
}
const quality = (value: string) =>
	["observed", "inferred", "confirmed", "tool_observed", "ambiguous", "unknown"].includes(value)
const gitID = (value: string) =>
	typeof value === "string" &&
	(value.length === 40 || value.length === 64) &&
	Buffer.from(value, "hex").toString("hex") === value
function dec(s: unknown): bigint | undefined {
	if (typeof s === "number" && Number.isSafeInteger(s)) return BigInt(s)
	if (typeof s !== "string" || !s.length) return
	const digits = s.startsWith("-") ? s.slice(1) : s
	if (!digits.length || !Array.from(digits).every(digit)) return
	const n = BigInt(s)
	return n >= -(1n << 63n) && n < 1n << 63n ? n : undefined
}
function rawValid(raw: RawUsage = {}): boolean {
	for (const key of [
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"reasoningTokens",
	] as const) {
		if (raw[key] != null) {
			const n = dec(raw[key])
			if (n == null || n < 0 || n > 1_000_000_000_000n) return false
		}
	}
	if ((raw.cacheWrites?.length ?? 0) > 16) return false
	const ttls = new Set<number>()
	let writes = 0n
	for (const w of raw.cacheWrites ?? []) {
		const n = dec(w.tokens)
		if (
			!Number.isInteger(w.ttlSeconds) ||
			w.ttlSeconds < 1 ||
			w.ttlSeconds > 86400 ||
			n == null ||
			n < 0 ||
			n > 1_000_000_000_000n ||
			ttls.has(w.ttlSeconds)
		)
			return false
		ttls.add(w.ttlSeconds)
		writes += n
	}
	const writeTotal = dec(raw.cacheWriteTokens)
	const reasoning = dec(raw.reasoningTokens)
	const output = dec(raw.outputTokens)
	return (
		(writeTotal === undefined || writes <= writeTotal) &&
		(reasoning === undefined || output === undefined || reasoning <= output)
	)
}
function issueValid(keys: IssueKey[] = []): boolean {
	return (
		keys.length <= 20 &&
		keys.every((v) => {
			const parts = v.key.split("-"),
				prefix = parts[0] ?? "",
				suffix = parts[1] ?? ""
			return (
				parts.length === 2 &&
				prefix.length >= 1 &&
				prefix.length <= 32 &&
				suffix.length >= 1 &&
				suffix.length <= 20 &&
				Array.from(prefix).every((c, i) => (c >= "A" && c <= "Z") || (i > 0 && digit(c))) &&
				Array.from(suffix).every(digit) &&
				["work", "branch", "title", "commit", "explicit"].includes(v.source) &&
				(dec(v.revision ?? "0") ?? -1n) >= 0n
			)
		})
	)
}
export function validateEvent(e: Event): void {
	const rev = dec(e.revision),
		base = dec(e.baseRevision ?? "0")
	if (
		!e.id ||
		!e.entityId ||
		!e.deviceId ||
		rev == null ||
		rev < 1 ||
		!e.observeTime ||
		e.observeTime === ZeroTime ||
		!Number.isFinite(Date.parse(e.observeTime)) ||
		!e.source ||
		!bounded(e.source, 64)
	)
		throw new Error("missing event identity")
	if (Temporal.Instant.from(e.observeTime).epochNanoseconds === Temporal.Instant.from(ZeroTime).epochNanoseconds)
		throw new Error("missing event identity")
	if (payloads.filter((k) => e[k] != null).length !== 1) throw new Error("exactly one typed event is required")
	if (base !== rev - 1n || (rev > 1n && !e.baseHash)) throw new Error("invalid revision chain")
	for (const id of [e.id, e.entityId, e.deviceId, e.workId, e.sessionId, e.turnId, e.agentId])
		if (Buffer.byteLength(id ?? "") > 128 || containsAny(id ?? "", "\r\n\0")) throw new Error("invalid identity")
	if (Buffer.byteLength(encodeEvent(e)) > 65536) throw new Error("event exceeds bound")
	const invalid: () => never = () => {
		throw new Error("invalid typed event evidence")
	}
	validateClaimEvidence(e, invalid)
	if (!bounded(e.sourceVersion, 64) || !e.sourceVersion) invalid()
	const r = e.repository
	if (
		r &&
		(!["github", "gitlab"].includes(r.provider) ||
			!r.host ||
			!bounded(r.host, 253) ||
			containsAny(r.host, "/\\@?#| :") ||
			!r.id ||
			!opaque(r.id) ||
			!bounded(r.name, 256) ||
			containsAny(r.name ?? "", "@?#|\\"))
	)
		invalid()
	if (e.work) {
		const w = e.work
		if (
			!bounded(w.title, 512) ||
			!opaque(w.planId) ||
			!opaque(w.planRevision) ||
			!bounded(w.reason, 64) ||
			!quality(w.quality) ||
			!issueValid(w.issueKeys)
		)
			invalid()
	}
	if (e.usage) {
		const u = e.usage
		if (
			!rawValid(u.raw) ||
			!["request", "cumulative"].includes(u.counterScope) ||
			!["api", "subscription", "credits", "gateway", "unknown"].includes(u.billingBasis) ||
			!bounded(u.observedRoute, 253) ||
			containsAny(u.observedRoute, "@?#\r\n") ||
			!opaque(u.requestId) ||
			!opaque(u.responseId) ||
			["reportedModel", "actualModel"].some((k) => !bounded(u[k as keyof Usage], 128)) ||
			["provider", "serviceTier", "region", "channel", "correlation", "schema", "stopReason", "billingStatus"].some(
				(k) => !bounded(u[k as keyof Usage], 64),
			) ||
			(u.iterations?.length ?? 0) > 16 ||
			(u.aliases?.length ?? 0) > 8 ||
			(u.credits?.length ?? 0) > 16
		)
			invalid()
		if (u.durationMs != null) {
			const duration = dec(u.durationMs)
			if (duration === undefined || duration < 0n || duration > 86_400_000n) invalid()
		}
		for (const it of u.iterations ?? [])
			if (
				!opaque(it.id) ||
				!rawValid(it.raw) ||
				!bounded(it.model, 128) ||
				["schema", "billingStatus", "stopReason"].some((k) => !bounded(it[k as keyof Iteration], 64))
			)
				invalid()
		for (const a of u.aliases ?? [])
			if (
				!["castai-request-id", "provider-request-id", "provider-response-id"].includes(a.namespace) ||
				!a.id ||
				!opaque(a.id) ||
				!["mod", "transcript", "telemetry"].includes(a.source)
			)
				invalid()
		for (const c of u.credits ?? [])
			if (
				!c.amount ||
				!bounded(c.amount, 64) ||
				!bounded(c.unit, 32) ||
				!bounded(c.basis, 64) ||
				c.amount.split(".").length > 2 ||
				!Array.from(c.amount).every((v) => digit(v) || v === ".")
			)
				invalid()
	}
	if (e.tool) {
		const t = e.tool,
			d = dec(t.durationMs ?? "0")
		if (
			!bounded(t.name, 128) ||
			!opaque(t.requestEntityId) ||
			!t.callId ||
			!opaque(t.callId) ||
			!["read", "edit", "shell", "plan", "other"].includes(t.category) ||
			!["completed", "failed", "interrupted"].includes(t.outcome) ||
			d == null ||
			d < 0 ||
			d > 86_400_000
		)
			invalid()
	}
	if (e.file) {
		const f = e.file
		if (
			!f.fileId ||
			[f.fileId, f.beforeRevision, f.afterRevision, f.toolCallId].some((v) => !opaque(v)) ||
			!quality(f.quality) ||
			!["created", "modified", "deleted", "renamed", "read"].includes(f.operation)
		)
			invalid()
	}
	if (e.commit) {
		const c = e.commit
		if (!gitID(c.id) || (c.parents?.length ?? 0) > 16 || !quality(c.quality) || c.parents?.some((p) => !gitID(p)))
			invalid()
	}
	if (e.pullRequest) {
		const p = e.pullRequest
		if (Array.from(p.uri).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
			invalid()
		let u: URL
		try {
			u = new URL(p.uri)
		} catch {
			invalid()
		}
		if (
			u.protocol !== "https:" ||
			!u.host ||
			u.username ||
			u.password ||
			u.search ||
			u.hash ||
			!r ||
			u.hostname.toLowerCase() !== r.host.toLowerCase() ||
			!p.id ||
			!opaque(p.id) ||
			!Number.isInteger(p.number) ||
			p.number <= 0 ||
			p.number > 2147483647 ||
			!["open", "closed", "merged"].includes(p.state) ||
			!bounded(p.title, 512) ||
			!issueValid(p.issueKeys) ||
			(p.mergeCommitId && !gitID(p.mergeCommitId))
		)
			invalid()
	}
	if (e.link) {
		const l = e.link,
			kinds = ["work", "commit", "pull_request", "usage", "file"]
		if (
			!kinds.includes(l.fromKind) ||
			!kinds.includes(l.toKind) ||
			!l.fromId ||
			!opaque(l.fromId) ||
			!l.toId ||
			!opaque(l.toId) ||
			!quality(l.quality) ||
			!bounded(l.reason, 64)
		)
			invalid()
	}
	if (e.coverage) {
		const c = e.coverage
		if (
			!c.code ||
			!opaque(c.code) ||
			(dec(c.count) ?? 0n) < 1n ||
			!bounded(c.model, 128) ||
			(c.observedUsage != null && !rawValid(c.observedUsage)) ||
			(c.windowStartTime &&
				c.windowEndTime &&
				Temporal.Instant.from(c.windowEndTime).epochNanoseconds <
					Temporal.Instant.from(c.windowStartTime).epochNanoseconds)
		)
			invalid()
	}
}
export function validateBatch(b: Batch): void {
	if (b.version !== Version || !b.id || Buffer.byteLength(b.id) > 128 || !b.events.length || b.events.length > 500)
		throw new Error("invalid batch")
	const seen = new Set<string>()
	for (const e of b.events) {
		validateEvent(e)
		if (seen.has(e.id)) throw new Error("duplicate event in batch")
		seen.add(e.id)
	}
}

function validateAccountingRaw(schema: string, raw: RawUsage, partition: boolean): void {
	let writes = 0n
	for (const write of raw.cacheWrites ?? []) writes += BigInt(write.tokens)
	if (writes > 1_000_000_000_000n) throw new Error("Cache TTL counters exceed total")
	if (
		partition &&
		["openai-responses-v1", "openai-chat-completions-v1"].includes(schema) &&
		raw.inputTokens !== undefined &&
		raw.cacheReadTokens !== undefined &&
		raw.cacheWriteTokens !== undefined &&
		BigInt(raw.cacheReadTokens) + BigInt(raw.cacheWriteTokens) > BigInt(raw.inputTokens)
	)
		throw new Error("Included cache counters exceed input")
}

/** Shared service admission precedes durable CAS; cumulative counters remain supplemental evidence. */
export function validateIngestEvent(event: Event): void {
	validateEvent(event)
	if ([event.id, event.entityId, event.deviceId].some((id) => !uuidBytes(id))) throw new Error("Invalid event identity")
	const observed = Temporal.Instant.from(event.observeTime).epochNanoseconds
	if (observed < 0n || observed > BigInt(Date.now()) * 1_000_000n + 600_000_000_000n)
		throw new Error("Event outside supported accounting timestamps")
	const usage = event.usage
	if (!usage) return
	validateAccountingRaw(usage.schema, usage.raw, false)
	if (usage.counterScope === "cumulative") return
	const iterations = usage.iterations ?? []
	if (!iterations.length) {
		if (usage.finalIterationId) throw new Error("Final iteration does not exist")
		validateAccountingRaw(usage.schema, usage.raw, true)
		return
	}
	const ids = new Set<string>()
	for (const iteration of iterations) {
		if (!iteration.id || ids.has(iteration.id)) throw new Error("Invalid or duplicate iteration identity")
		ids.add(iteration.id)
		validateAccountingRaw(iteration.schema, iteration.raw, true)
	}
	if (usage.finalIterationId && !ids.has(usage.finalIterationId)) throw new Error("Final iteration does not exist")
}

export function validateIngestBatch(batch: Batch): void {
	validateBatch(batch)
	if (!uuidBytes(batch.id)) throw new Error("Invalid batch identity")
	for (const event of batch.events) validateIngestEvent(event)
}
