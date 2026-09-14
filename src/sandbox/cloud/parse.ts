/**
 * Parse a proto-JSON integer field. gRPC-gateway encodes int64 as a JSON
 * *string* ("1500") while int32 arrives as a number — accept both so callers
 * don't need to care about the wire width. Only canonical decimal encodings
 * are accepted: strings matching anything else JS would coerce (whitespace,
 * hex "0x10", exponent "1e3", fractional "12.5") degrade to undefined
 * instead of silently parsing. Returns undefined when the field is absent
 * or not parseable as a finite integer.
 */
export function parseInt64(raw: unknown): number | undefined {
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined
	if (typeof raw === "string" && /^-?[0-9]+$/.test(raw)) {
		const n = Number(raw)
		if (Number.isFinite(n)) return n
	}
	return undefined
}
