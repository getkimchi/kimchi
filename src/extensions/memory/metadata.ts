import { createHash } from "node:crypto"
import { EXTRACTION_DERIVED_TAG } from "./config.js"

export const MEMORY_METADATA_VERSION = 1

export type MemoryKind = "semantic" | "procedural" | "episodic" | "working" | "hypothesis" | "unclassified"
export type MemorySource = "extracted" | "authored" | "imported" | "consolidated" | "unknown"
export type MemoryAttribute = string | number | boolean

export interface MemoryMetadata {
	version: typeof MEMORY_METADATA_VERSION
	kind: MemoryKind
	source: MemorySource
	episode?: string
	validOrder?: number
	validAt?: string
	confidence?: number
	derived?: boolean
	canonical?: boolean
	supportIds?: readonly string[]
	supersedes?: readonly string[]
	attributes?: Readonly<Record<string, MemoryAttribute>>
	normalizedTextHash?: string
}

export type MemoryMetadataInput = Omit<MemoryMetadata, "version" | "normalizedTextHash">

const KINDS = new Set<MemoryKind>(["semantic", "procedural", "episodic", "working", "hypothesis", "unclassified"])
const SOURCES = new Set<MemorySource>(["extracted", "authored", "imported", "consolidated", "unknown"])
const DATE_PREFIX = /^as of (\d{4}-\d{2}-\d{2})(?:\b|[,; ])/i
const AUTHORED_PREFIX = "[authored] "
const TENTATIVE =
	/\b(?:perhaps|possibly|probably|likely|might|may|could|seem(?:s|ed|ing)?|appear(?:s|ed|ing)?|presumably|apparently|speculat(?:e|es|ed|ing))\b/i

function normalizedTextHash(text: string): string {
	return createHash("sha256").update(text.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex")
}

function explicitDate(text: string): string | undefined {
	const raw = text.match(DATE_PREFIX)?.[1]
	if (!raw) return undefined
	const [year, month, day] = raw.split("-").map(Number)
	const date = new Date(Date.UTC(year as number, (month as number) - 1, day as number))
	return date.getUTCFullYear() === year && date.getUTCMonth() === (month as number) - 1 && date.getUTCDate() === day
		? raw
		: undefined
}

/** Runtime validation for user-supplied lifecycle edits. */
export function isMemoryKind(value: unknown): value is MemoryKind {
	return typeof value === "string" && KINDS.has(value as MemoryKind)
}

/** New writes carry only supported, evidence-grounded fields. No observation
 * time is invented to fill validAt/validOrder. */
export function memoryMetadataForText(text: string, input: Partial<MemoryMetadataInput> = {}): MemoryMetadata {
	const derived = input.derived ?? text.startsWith(EXTRACTION_DERIVED_TAG)
	const source = input.source ?? (text.startsWith(AUTHORED_PREFIX) ? "authored" : "extracted")
	const kind =
		input.kind ?? (derived || TENTATIVE.test(text) ? "hypothesis" : explicitDate(text) ? "episodic" : "semantic")
	const validAt = input.validAt ?? explicitDate(text)
	const validOrder = input.validOrder ?? (validAt ? Number(validAt.replaceAll("-", "")) : undefined)
	return sanitizeMemoryMetadata(
		{
			...input,
			version: MEMORY_METADATA_VERSION,
			source,
			kind,
			derived,
			canonical: input.canonical ?? kind !== "hypothesis",
			validAt,
			validOrder,
		},
		text,
	)
}

/** Legacy or malformed rows are visible but not upgraded into trusted
 * observations. Known fields survive independently; invalid ones are omitted. */
export function readMemoryMetadata(raw: unknown, text: string): MemoryMetadata {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return legacyMemoryMetadata(text)
	const input = raw as Record<string, unknown>
	if (input.version !== undefined && input.version !== MEMORY_METADATA_VERSION) return legacyMemoryMetadata(text)
	return sanitizeMemoryMetadata(
		{
			...input,
			version: MEMORY_METADATA_VERSION,
			derived:
				typeof input.derived === "boolean" ? input.derived : text.startsWith(EXTRACTION_DERIVED_TAG) ? true : undefined,
		},
		text,
	)
}

function legacyMemoryMetadata(text: string): MemoryMetadata {
	return sanitizeMemoryMetadata(
		{ version: MEMORY_METADATA_VERSION, ...(text.startsWith(EXTRACTION_DERIVED_TAG) ? { derived: true } : {}) },
		text,
	)
}

function sanitizeMemoryMetadata(input: Record<string, unknown>, text: string): MemoryMetadata {
	const kind = KINDS.has(input.kind as MemoryKind) ? (input.kind as MemoryKind) : "unclassified"
	const source = SOURCES.has(input.source as MemorySource) ? (input.source as MemorySource) : "unknown"
	const result: MemoryMetadata = {
		version: MEMORY_METADATA_VERSION,
		kind,
		source,
		normalizedTextHash: normalizedTextHash(text),
	}
	if (typeof input.episode === "string" && input.episode.trim()) result.episode = input.episode
	if (typeof input.validOrder === "number" && Number.isSafeInteger(input.validOrder) && input.validOrder >= 0)
		result.validOrder = input.validOrder
	const validAt = typeof input.validAt === "string" ? explicitDate(`As of ${input.validAt}`) : undefined
	if (validAt) result.validAt = validAt
	if (
		typeof input.confidence === "number" &&
		Number.isFinite(input.confidence) &&
		input.confidence >= 0 &&
		input.confidence <= 1
	)
		result.confidence = input.confidence
	if (typeof input.derived === "boolean") result.derived = input.derived
	if (kind === "hypothesis") result.derived = true
	if (input.canonical === true) result.canonical = true
	else if (input.canonical === false || kind === "hypothesis") result.canonical = false
	const supportIds = stringIds(input.supportIds)
	if (supportIds?.length) result.supportIds = supportIds
	const supersedes = stringIds(input.supersedes)
	if (supersedes?.length) result.supersedes = supersedes
	const attributes = safeAttributes(input.attributes)
	if (attributes) result.attributes = attributes
	return result
}

export function memoryEvidencePrefix(text: string, metadata?: MemoryMetadata): string {
	if (text.startsWith(EXTRACTION_DERIVED_TAG)) return ""
	const parsed = readMemoryMetadata(metadata, text)
	if (parsed.derived || parsed.kind === "hypothesis") return "[derived] "
	if (parsed.kind === "unclassified") return ""
	const parts = [parsed.kind === "working" && parsed.canonical ? "current working" : parsed.kind]
	if (parsed.validAt) parts.push(`valid at ${parsed.validAt}`)
	if (parsed.canonical === true) parts.push("canonical")
	if (parsed.confidence !== undefined) parts.push(`confidence ${parsed.confidence.toFixed(2)}`)
	return `[${parts.join("; ")}] `
}

function stringIds(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined
	const ids = [
		...new Set(
			value
				.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
				.map((item) => item.trim()),
		),
	]
	return ids.slice(0, 64)
}

function safeAttributes(value: unknown): Readonly<Record<string, MemoryAttribute>> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
	const attributes: Record<string, MemoryAttribute> = {}
	for (const [key, raw] of Object.entries(value).slice(0, 32)) {
		if (!key || key.length > 64) continue
		if (typeof raw === "string" && raw.length <= 512) attributes[key] = raw
		else if (typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw))) attributes[key] = raw
	}
	return Object.keys(attributes).length > 0 ? attributes : undefined
}
