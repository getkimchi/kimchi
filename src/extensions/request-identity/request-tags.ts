/** The gateway's limit on combined body and header tags, counted before deduplication. */
const GATEWAY_TAG_LIMIT = 10

/**
 * The `kimchi-request:<request ID>` tag the gateway reports with the request, so its bill can be found by that ID. A
 * previous attempt's tag is dropped first; user tags are never dropped to make room.
 */
export function prepareBillingTag(
	headers: Headers,
	bodyTags: readonly string[] | undefined,
	requestId: string,
	ownsTag: (tag: string) => boolean,
): { billingTag?: string; billingTagSkipped?: string; header?: string } {
	const original = headers.get("X-Tags")
	const parts = original?.split(",") ?? []
	const retained = parts.filter((tag) => !ownsTag(tag.trim()))
	// Never resend a previous attempt's tag, even if persistence or body inspection
	// prevents tagging this attempt. Every unrelated user tag stays intact.
	if (retained.length !== parts.length) {
		if (retained.length) headers.set("X-Tags", retained.join(","))
		else headers.delete("X-Tags")
	}
	if (bodyTags === undefined) return { billingTagSkipped: "body-uninspectable" }
	const tags = [...retained, ...(headers.get("X-LiteLLM-Tags")?.split(",") ?? []), ...bodyTags]
		.map((tag) => tag.trim())
		.filter(Boolean)
	if (tags.some((tag) => tag.split(":", 1)[0] === "kimchi-request")) return { billingTagSkipped: "reserved-tag" }
	// The gateway counts combined entries before deduplication, including repeated tags.
	if (tags.length >= GATEWAY_TAG_LIMIT) return { billingTagSkipped: "tag-limit" }
	const billingTag = `kimchi-request:${requestId}`
	return { billingTag, header: [...retained, billingTag].join(",") }
}
