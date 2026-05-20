import { complete } from "@earendil-works/pi-ai"
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
	getImageDataHash,
	getLatestMessages,
	hasImages,
	markImagesAsStripped,
	sessionHasImages,
	storeImageDescription,
} from "./model-guard.js"

const IMAGE_DESCRIPTION_PROMPT = "Describe this image concisely. Include key visual details, text, layout."

/**
 * Collect all unique image blocks from messages.
 */
function collectImages(messages: ReturnType<typeof getLatestMessages>): Map<string, ImageContent> {
	const images = new Map<string, ImageContent>()

	for (const msg of messages) {
		if (!("content" in msg)) continue
		const content = msg.content
		if (typeof content === "string") continue
		if (!Array.isArray(content)) continue

		for (const block of content) {
			if (block.type === "image") {
				const img = block as ImageContent
				const hash = getImageDataHash(img.data)
				if (!images.has(hash)) {
					images.set(hash, img)
				}
			}
		}
	}

	return images
}

/**
 * Get a vision-capable model from the registry.
 * Returns current model if it has vision, otherwise first available vision model.
 */
function findVisionModel(ctx: ExtensionContext): Model<Api> | undefined {
	// Check if current model supports vision
	if (ctx.model?.input?.includes("image")) {
		return ctx.model as Model<Api>
	}

	// Find first vision-capable model from available models
	const available = ctx.modelRegistry?.getAvailable() ?? []
	for (const model of available) {
		if (model.input?.includes("image")) {
			return model as Model<Api>
		}
	}

	return undefined
}

export default function stripImagesExtension(pi: ExtensionAPI) {
	pi.registerCommand("strip-images", {
		description: "Process images with AI to generate descriptions, then strip them for non-vision model compatibility",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!sessionHasImages()) {
				ctx.ui.notify("No images in current context.", "info")
				return
			}

			const messages = getLatestMessages()
			if (!hasImages(messages)) {
				ctx.ui.notify("No images to process.", "info")
				return
			}

			// Find a vision-capable model
			const visionModel = findVisionModel(ctx)
			if (!visionModel) {
				ctx.ui.notify(
					"No vision-capable model available to describe images. Add a vision model to your enabled models, then retry.",
					"error",
				)
				return
			}

			// Get API key and headers
			const auth = await ctx.modelRegistry?.getApiKeyAndHeaders(visionModel)
			if (!auth?.ok || !auth?.apiKey) {
				ctx.ui.notify(`Cannot access ${visionModel.id} — no API key available. Check your configuration.`, "error")
				return
			}

			ctx.ui.notify(`Analyzing images with ${visionModel.id}...`, "info")

			// Collect all unique images
			const images = collectImages(messages)

			let processedCount = 0
			const errors: string[] = []
			for (const [hash, img] of images) {
				try {
					const response = await complete(
						visionModel,
						{
							systemPrompt: IMAGE_DESCRIPTION_PROMPT,
							messages: [
								{
									role: "user",
									content: [
										{
											type: "image" as const,
											data: img.data,
											mimeType: img.mimeType ?? "image/png",
										} as ImageContent,
									],
									timestamp: Date.now(),
								},
							],
						},
						{
							apiKey: auth.apiKey,
							headers: auth.headers,
							signal: AbortSignal.timeout(45_000),
							maxTokens: 200,
						},
					)

					// Extract text from response
					const description = (response.content as TextContent[])
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("")
						.trim()

					if (description) {
						storeImageDescription(hash, description)
						processedCount++
					}
				} catch (err) {
					errors.push(err instanceof Error ? err.message : String(err))
				}
			}

			// Mark images as stripped so they'll be replaced with descriptions in context
			markImagesAsStripped()

			if (processedCount === 0) {
				const detail = errors.length > 0 ? ` Error: ${errors[0]}` : ""
				ctx.ui.notify(
					`Images stripped without descriptions due to processing errors.${detail} Non-vision models are now available.`,
					"warning",
				)
			} else {
				ctx.ui.notify(
					`Stripped ${processedCount} image${processedCount > 1 ? "s" : ""} with AI descriptions — non-vision models are now available.`,
					"info",
				)
			}
		},
	})
}
