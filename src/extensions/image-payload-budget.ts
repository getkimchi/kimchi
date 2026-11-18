/**
 * Bounds the final provider request by replacing the oldest embedded images
 * when cumulative base64 history would exceed the gateway's body-size limit.
 * Runs on the provider payload so it covers compaction side calls and both
 * interactive and ACP sessions without changing saved history.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { base64OfImageBlock } from "./undecodable-image-sanitizer.js"

/** One MiB below the direct Kimchi gateway's 25 MiB nginx request limit. */
export const DEFAULT_MAX_PROVIDER_PAYLOAD_BYTES = 24 * 1024 * 1024
export const IMAGE_PAYLOAD_REMOVED_NOTE = "[image omitted: retained image history exceeded the request size limit]"

type ImageLocation = {
	parent: Record<string, unknown> | unknown[]
	key: string | number
	block: Record<string, unknown>
}

function isEmbeddedImageBlock(block: Record<string, unknown>): boolean {
	if (block.type === "input_image") {
		return typeof block.image_url === "string" && block.image_url.startsWith("data:")
	}
	return base64OfImageBlock(block) !== null
}

function collectImageLocations(
	value: unknown,
	parent: Record<string, unknown> | unknown[],
	key: string | number,
	out: ImageLocation[],
): void {
	if (!value || typeof value !== "object") return
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) collectImageLocations(value[index], value, index, out)
		return
	}
	const block = value as Record<string, unknown>
	if (isEmbeddedImageBlock(block)) {
		out.push({ parent, key, block })
		return
	}
	for (const [childKey, child] of Object.entries(block)) collectImageLocations(child, block, childKey, out)
}

function replacementFor(block: Record<string, unknown>): Record<string, string> {
	return { type: block.type === "input_image" ? "input_text" : "text", text: IMAGE_PAYLOAD_REMOVED_NOTE }
}

function replace(location: ImageLocation, replacement: Record<string, string>): void {
	if (Array.isArray(location.parent)) location.parent[Number(location.key)] = replacement
	else location.parent[String(location.key)] = replacement
}

/** Returns the number of oldest-first image blocks replaced to fit maxBytes. */
export function trimImagePayloadToBudget(payload: unknown, maxBytes = DEFAULT_MAX_PROVIDER_PAYLOAD_BYTES): number {
	if (!payload || typeof payload !== "object") return 0
	let bytes = Buffer.byteLength(JSON.stringify(payload))
	if (bytes <= maxBytes) return 0

	const images: ImageLocation[] = []
	collectImageLocations(payload, [], 0, images)
	let removed = 0
	for (const image of images) {
		const replacement = replacementFor(image.block)
		bytes -= Buffer.byteLength(JSON.stringify(image.block)) - Buffer.byteLength(JSON.stringify(replacement))
		replace(image, replacement)
		removed++
		if (bytes <= maxBytes) break
	}
	return removed
}

const imagePayloadBudgetExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.on("before_provider_request", (event: unknown) => {
		const payload = (event as Record<string, unknown> | null)?.payload
		const removed = trimImagePayloadToBudget(payload)
		if (removed === 0) return
		console.debug(`[image-payload-budget] omitted ${removed} old image block(s) to fit the request size limit`)
		return payload
	})
}

export default imagePayloadBudgetExtension
