import { createHash } from "node:crypto"

declare const Temporal: {
	Instant: {
		from(value: string): {
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
	id?: string
	entityId: string
	revision?: string
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
