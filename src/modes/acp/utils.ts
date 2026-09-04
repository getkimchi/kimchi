import type { ImageContent } from "@earendil-works/pi-ai"

export const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
export const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s)

/**
 * Extract pi-ai `ImageContent[]` from ACP-shaped image content blocks
 * (`{ type: "image", data, mimeType }`). Non-image and malformed blocks are
 * dropped; callers that need strict validation should check lengths.
 */
export function extractImages(blocks: unknown[]): ImageContent[] {
	return blocks
		.filter((b): b is { type: "image"; data: string; mimeType: string } => {
			if (!b || typeof b !== "object") return false
			const block = b as Record<string, unknown>
			return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
		})
		.map((b) => ({ type: "image" as const, data: b.data, mimeType: b.mimeType }))
}

export function requestWithAbort<T>(request: Promise<T>, signal: AbortSignal | undefined): Promise<T | "aborted"> {
	if (!signal) return request
	if (signal.aborted) return Promise.resolve("aborted")

	return new Promise((resolve, reject) => {
		const onAbort = () => resolve("aborted")
		signal.addEventListener("abort", onAbort, { once: true })
		request.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
	})
}
