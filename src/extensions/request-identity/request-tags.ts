/** The gateway's limit on combined body and header tags, counted before deduplication, repeated tags included. */
const GATEWAY_TAG_LIMIT = 10

const BILLING_TAG_KEY = "kimchi-request"

/** The prefix of the tag the gateway finds a request's bill by: `kimchi-request:<request ID>`. */
export const BILLING_TAG_PREFIX = `${BILLING_TAG_KEY}:`

/** The header of a request's comma-separated gateway tags. */
export const TAGS_HEADER = "X-Tags"

/**
 * The billing tag of one attempt and the `X-Tags` value that carries it, or undefined when the attempt cannot be
 * tagged. Earlier attempts' tags are removed from `headers` at once, so a retry never resends them; user tags are never
 * dropped to make room.
 */
export function prepareBillingTag(
	headers: Headers,
	bodyTags: readonly string[] | undefined,
	requestId: string,
	ownsTag: (tag: string) => boolean,
): { tag: string; header: string } | undefined {
	const parts = headers.get(TAGS_HEADER)?.split(",") ?? []
	const retained = parts.filter((tag) => !ownsTag(tag.trim()))
	if (retained.length !== parts.length) {
		if (retained.length) headers.set(TAGS_HEADER, retained.join(","))
		else headers.delete(TAGS_HEADER)
	}
	if (bodyTags === undefined) return undefined
	const tags = [...retained, ...(headers.get("X-LiteLLM-Tags")?.split(",") ?? []), ...bodyTags]
		.map((tag) => tag.trim())
		.filter(Boolean)
	// A tag of the user's own with the same key, or no free slot, leaves the attempt untagged.
	if (tags.length >= GATEWAY_TAG_LIMIT || tags.some((tag) => tag.split(":", 1)[0] === BILLING_TAG_KEY)) return undefined
	const tag = `${BILLING_TAG_PREFIX}${requestId}`
	return { tag, header: [...retained, tag].join(",") }
}
