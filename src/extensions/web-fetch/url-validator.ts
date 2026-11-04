// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/**
 * URL validation and SSRF protection for the web_fetch tool.
 *
 * Validates URL format (http/https only) and blocks requests to private
 * IP ranges, localhost, and cloud metadata endpoints.
 */

/** Private IPv4 ranges that must be blocked. */
const PRIVATE_IPV4_RANGES = [
	{ prefix: "10.", label: "private (10.0.0.0/8)" },
	{ prefix: "127.", label: "loopback (127.0.0.0/8)" },
	{ prefix: "169.254.", label: "link-local (169.254.0.0/16)" },
	{ prefix: "192.168.", label: "private (192.168.0.0/16)" },
] as const

/** Check if an IPv4 address falls in the 172.16.0.0/12 range (172.16.x – 172.31.x). */
function isPrivate172(host: string): boolean {
	if (!host.startsWith("172.")) return false
	const parts = host.split(".")
	if (parts.length !== 4) return false
	const second = Number.parseInt(parts[1], 10)
	return second >= 16 && second <= 31
}

/** Private IPv6 addresses / prefixes that must be blocked. */
const BLOCKED_IPV6 = ["::1", "0:0:0:0:0:0:0:1"] as const

/** Check if a hostname is a blocked IPv6 address (loopback or unique-local fc00::/7). */
function isBlockedIPv6(host: string): boolean {
	// Strip surrounding brackets that URL parsing may leave
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
	const lower = bare.toLowerCase()
	if ((BLOCKED_IPV6 as readonly string[]).includes(lower)) return true
	// fc00::/7 covers fc00:: – fdff::
	if (lower.startsWith("fc") || lower.startsWith("fd")) return true
	return false
}

/** Cloud metadata endpoints. */
const METADATA_HOSTS = ["169.254.169.254", "metadata.google.internal"] as const

/** Localhost aliases. */
const LOCALHOST_ALIASES = ["localhost", "localhost.localdomain"] as const

export interface ValidationResult {
	valid: true
	url: URL
}

export interface ValidationError {
	valid: false
	error: string
}

export type ValidateURLResult = ValidationResult | ValidationError

/**
 * Validate a URL for use with web_fetch.
 *
 * Checks:
 *  1. URL parses correctly
 *  2. Scheme is http or https
 *  3. Hostname is not a private IP, localhost, or cloud metadata endpoint
 */
export function validateURL(raw: string): ValidateURLResult {
	// 1. Parse
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return { valid: false, error: `Invalid URL: "${raw}" is not a valid URL` }
	}

	// 2. Scheme
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return {
			valid: false,
			error: `Unsupported scheme: "${url.protocol.replace(":", "")}". Only http and https are allowed`,
		}
	}

	const hostname = url.hostname

	// 3a. Localhost aliases
	if ((LOCALHOST_ALIASES as readonly string[]).includes(hostname.toLowerCase())) {
		return { valid: false, error: "Blocked URL: requests to localhost are not allowed (SSRF protection)" }
	}

	// 3b. Cloud metadata endpoints
	if ((METADATA_HOSTS as readonly string[]).includes(hostname.toLowerCase())) {
		return {
			valid: false,
			error: `Blocked URL: requests to cloud metadata endpoint "${hostname}" are not allowed (SSRF protection)`,
		}
	}

	// 3c. Private IPv4 ranges
	for (const range of PRIVATE_IPV4_RANGES) {
		if (hostname.startsWith(range.prefix)) {
			return {
				valid: false,
				error: `Blocked URL: "${hostname}" is a ${range.label} address (SSRF protection)`,
			}
		}
	}
	if (isPrivate172(hostname)) {
		return {
			valid: false,
			error: `Blocked URL: "${hostname}" is a private (172.16.0.0/12) address (SSRF protection)`,
		}
	}

	// 3d. Blocked IPv6 addresses
	if (isBlockedIPv6(hostname)) {
		return {
			valid: false,
			error: `Blocked URL: "${hostname}" is a blocked IPv6 address (SSRF protection)`,
		}
	}

	// 3e. IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1 hex form)
	const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
	const lower = bare.toLowerCase()

	// Decimal form: ::ffff:127.0.0.1
	const v4MappedDecimal = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
	if (v4MappedDecimal) {
		const innerResult = validateURL(`http://${v4MappedDecimal[1]}/`)
		if (!innerResult.valid) {
			return {
				valid: false,
				error: `Blocked URL: "${hostname}" maps to a blocked IPv4 address (SSRF protection)`,
			}
		}
	}

	// Hex form: ::ffff:7f00:1 (Node's URL parser normalizes to this)
	const v4MappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
	if (v4MappedHex) {
		const hi = Number.parseInt(v4MappedHex[1], 16)
		const lo = Number.parseInt(v4MappedHex[2], 16)
		const ip = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
		const innerResult = validateURL(`http://${ip}/`)
		if (!innerResult.valid) {
			return {
				valid: false,
				error: `Blocked URL: "${hostname}" maps to a blocked IPv4 address (SSRF protection)`,
			}
		}
	}

	return { valid: true, url }
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker

export const DUMB_TEST_MARKER_LLM_4329 = "llm-4329-dumb-test-marker"
