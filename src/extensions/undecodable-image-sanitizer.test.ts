import { describe, expect, it } from "vitest"
import { PNG_SIGNATURE } from "../utils/image-utils.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import undecodableImageSanitizerExtension, {
	base64OfImageBlock,
	stripUndecodableImages,
} from "./undecodable-image-sanitizer.js"

const PNG_B64 = Buffer.from(PNG_SIGNATURE).toString("base64")
const PDF_B64 = Buffer.from("%PDF-1.3\n1 0 obj\n<</Type/Catalog/Pages").toString("base64")
const NOTE = "[image removed: corrupt or unsupported image data]"

/** The shape openai-completions buildParams produces (what the hook actually sees). */
function openaiImageUrl(url: string) {
	return { type: "image_url", image_url: { url } }
}

function imageBlock(data: string, mimeType = "image/png") {
	return { type: "image", data, mimeType }
}

/** Fire the extension's before_provider_request handler against a payload. */
function fireBeforeProviderRequest(payload: unknown): unknown {
	const api = createExtensionApi()
	undecodableImageSanitizerExtension(api.api)
	const handler = api.getHandler("before_provider_request")
	return handler({ type: "before_provider_request", payload }, {} as never)
}

describe("base64OfImageBlock", () => {
	it("extracts base64 from every supported shape and skips non-decodable blocks", () => {
		expect(base64OfImageBlock(openaiImageUrl(`data:image/png;base64,${PDF_B64}`))).toBe(PDF_B64)
		expect(base64OfImageBlock(imageBlock(PDF_B64))).toBe(PDF_B64)
		expect(base64OfImageBlock({ type: "image", source: { type: "base64", data: PDF_B64 } })).toBe(PDF_B64)
		// Remote URLs have nothing local to sniff; non-image blocks are skipped.
		expect(base64OfImageBlock(openaiImageUrl("https://example.com/i.png"))).toBeNull()
		expect(base64OfImageBlock({ type: "text", text: "hi" })).toBeNull()
		expect(base64OfImageBlock(null)).toBeNull()
	})
})

describe("stripUndecodableImages", () => {
	it("replaces undecodable openai image_url blocks and keeps decodable ones", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "text", text: "check this" }, openaiImageUrl(`data:image/png;base64,${PDF_B64}`)],
			},
			{ role: "user", content: [openaiImageUrl(`data:image/png;base64,${PNG_B64}`)] },
		]

		expect(stripUndecodableImages(messages)).toBe(1)
		expect((messages[0].content as Array<{ type: string; text?: string }>)[1].text).toBe(NOTE)
		expect((messages[1].content as Array<{ image_url?: { url?: string } }>)[0].image_url?.url).toBe(
			`data:image/png;base64,${PNG_B64}`,
		)
	})

	it("leaves remote https images and non-array content untouched", () => {
		const block = openaiImageUrl("https://example.com/i.png")
		const messages = [
			{ role: "user", content: [block] },
			{ role: "user", content: "just text" },
		]

		expect(stripUndecodableImages(messages)).toBe(0)
		expect((messages[0].content as unknown[])[0]).toBe(block)
		expect(messages[1].content).toBe("just text")
	})

	it("replaces undecodable flat pi-ai blocks and keeps decodable ones", () => {
		const messages = [
			{ role: "user", content: [imageBlock(PDF_B64), { type: "text", text: "check this" }] },
			{ role: "user", content: [imageBlock(PNG_B64)] },
		]

		expect(stripUndecodableImages(messages)).toBe(1)
		expect((messages[0].content as Array<{ type: string; text?: string }>)[0].text).toBe(NOTE)
		expect((messages[1].content as Array<{ data?: string }>)[0].data).toBe(PNG_B64)
	})
})

describe("undecodableImageSanitizerExtension", () => {
	it("replaces poisoned images in the outgoing params and returns the payload", () => {
		const payload = {
			model: "test",
			messages: [{ role: "user", content: [openaiImageUrl(`data:image/png;base64,${PDF_B64}`)] }],
		}

		const result = fireBeforeProviderRequest(payload) as typeof payload | undefined

		const content = (result?.messages[0] as { content: Array<{ type: string; text?: string }> }).content
		expect(content[0].text).toBe(NOTE)
	})

	it("returns undefined (no-op) for a clean payload and ignores malformed payloads", () => {
		expect(
			fireBeforeProviderRequest({
				messages: [{ role: "user", content: [openaiImageUrl(`data:image/png;base64,${PNG_B64}`)] }],
			}),
		).toBeUndefined()
		expect(fireBeforeProviderRequest({ other: "field" })).toBeUndefined()
		expect(fireBeforeProviderRequest(null)).toBeUndefined()
	})
})
