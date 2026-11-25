import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai"
import { complete } from "@earendil-works/pi-ai/compat"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAutoRoutedModel } from "./auto-model/constants.js"
import { getEffectiveModel } from "./auto-model/state.js"
import {
	getImageDataHash,
	type getLatestMessages,
	hasImages,
	markImagesAsStripped,
	refreshedSessionIsCurrent,
	refreshLatestMessagesFromSession,
	sessionHasImages,
	storeImageDescription,
} from "./model-guard.js"
import { createNativeUsageCapture } from "./work-attribution/native-usage.js"
import { getWorkId, pinWorkContext, recordProviderRequest, warnWorkAttribution } from "./work-attribution.js"

const IMAGE_DESCRIPTION_PROMPT = "Describe this image concisely. Include key visual details, text, layout."

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
				if (!images.has(hash)) images.set(hash, img)
			}
		}
	}

	return images
}

function findVisionModel(ctx: ExtensionContext): Model<Api> | undefined {
	const currentModel = getEffectiveModel(ctx)
	if (currentModel?.input.includes("image") && !isAutoRoutedModel(currentModel)) return currentModel

	const available = ctx.modelRegistry?.getAvailable() ?? []
	for (const model of available) {
		if (model.input?.includes("image") && !isAutoRoutedModel(model)) return model as Model<Api>
	}

	return undefined
}

export type StripSessionImagesResult =
	| { status: "no-images" }
	| { status: "refresh-failed"; reason: "superseded" | "error" }
	| { status: "no-vision-model" }
	| { status: "missing-auth"; modelId: string }
	| { status: "stripped"; modelId: string; processedCount: number; errors: string[] }

export async function stripSessionImages(ctx: ExtensionContext): Promise<StripSessionImagesResult> {
	const refreshed = await refreshLatestMessagesFromSession(ctx)
	if (refreshed.status !== "ok") return { status: "refresh-failed", reason: refreshed.status }

	if (!sessionHasImages() || !hasImages(refreshed.messages)) return { status: "no-images" }

	const visionModel = findVisionModel(ctx)
	if (!visionModel) return { status: "no-vision-model" }

	const workContext = pinWorkContext(ctx)
	let workId: string | undefined
	try {
		workId = getWorkId(workContext)
	} catch (error) {
		warnWorkAttribution(ctx, error)
	}
	const auth = await ctx.modelRegistry?.getApiKeyAndHeaders(visionModel)
	if (!auth?.ok || !auth?.apiKey) return { status: "missing-auth", modelId: visionModel.id }
	if (!refreshedSessionIsCurrent(refreshed)) return { status: "refresh-failed", reason: "superseded" }

	ctx.ui.notify(`Analyzing images with ${visionModel.id}...`, "info")

	const images = collectImages(refreshed.messages)
	let processedCount = 0
	const errors: string[] = []
	for (const [hash, img] of images) {
		if (!refreshedSessionIsCurrent(refreshed)) return { status: "refresh-failed", reason: "superseded" }
		const headers = { ...auth.headers }
		let requestId: string | undefined
		if (workId) {
			try {
				requestId = recordProviderRequest(workContext, visionModel, workId).requestId
				headers["X-Request-Id"] = requestId
			} catch (error) {
				warnWorkAttribution(ctx, error)
			}
		}
		const usage = createNativeUsageCapture(visionModel)
		usage.bind(requestId)
		try {
			const response = await usage.complete(() =>
				complete(
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
						onProviderStreamEvent: usage.onProviderStreamEvent,
						headers,
						signal: AbortSignal.timeout(45_000),
						maxTokens: 200,
					},
				),
			)

			if (!refreshedSessionIsCurrent(refreshed)) return { status: "refresh-failed", reason: "superseded" }

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
			console.error(`[strip-images] image description failed with ${visionModel.id}:`, err)
			errors.push(err instanceof Error ? err.message : String(err))
		}
	}

	if (!refreshedSessionIsCurrent(refreshed)) return { status: "refresh-failed", reason: "superseded" }
	markImagesAsStripped()
	return { status: "stripped", modelId: visionModel.id, processedCount, errors }
}

export function formatStrippedImagesOutcome(result: Extract<StripSessionImagesResult, { status: "stripped" }>): string {
	if (result.processedCount === 0) {
		const detail = result.errors.length > 0 ? ` Error: ${result.errors[0]}` : ""
		return `Images stripped without descriptions due to processing errors.${detail}`
	}
	return `Stripped ${result.processedCount} image${result.processedCount > 1 ? "s" : ""} with AI descriptions`
}

export function notifyStripSessionImagesResult(ctx: ExtensionContext, result: StripSessionImagesResult): void {
	switch (result.status) {
		case "no-images":
			ctx.ui.notify("No images in current context.", "info")
			return
		case "refresh-failed":
			ctx.ui.notify(
				"Could not load the latest session images. Retry after the current session update finishes.",
				"error",
			)
			return
		case "no-vision-model":
			ctx.ui.notify(
				"No vision-capable model available to describe images. Add a vision model to your enabled models, then retry.",
				"error",
			)
			return
		case "missing-auth":
			ctx.ui.notify(`Cannot access ${result.modelId} — no API key available. Check your configuration.`, "error")
			return
		case "stripped": {
			const severity = result.processedCount === 0 ? "warning" : "info"
			ctx.ui.notify(`${formatStrippedImagesOutcome(result)} — non-vision models are now available.`, severity)
		}
	}
}

export default function stripImagesExtension(pi: ExtensionAPI) {
	pi.registerCommand("strip-images", {
		description: "Process images with AI to generate descriptions, then strip them for non-vision model compatibility",
		handler: async (_args, ctx: ExtensionContext) => {
			notifyStripSessionImagesResult(ctx, await stripSessionImages(ctx))
		},
	})
}
