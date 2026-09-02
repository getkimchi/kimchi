import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge"
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
import { ResourceFetchError, ResourceParseError } from "./errors.js"
import { logger } from "./logger.js"
import type { McpServerManager } from "./server-manager.js"
import type { UiResourceContent, UiResourceMeta } from "./types.js"

interface ResourceContentRecord {
	uri?: string
	mimeType?: string
	text?: string
	blob?: string
	_meta?: Record<string, unknown>
}

export class UiResourceHandler {
	private log = logger.child({ component: "UiResourceHandler" })

	constructor(private manager: McpServerManager) {}

	async readUiResource(serverName: string, uri: string): Promise<UiResourceContent> {
		const log = this.log.child({ server: serverName, uri })

		if (!uri.startsWith("ui://")) {
			throw new ResourceParseError(uri, "URI must start with ui://", { server: serverName })
		}

		log.debug("Fetching UI resource")

		let result: ReadResourceResult
		try {
			result = await this.manager.readResource(serverName, uri)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			log.error("Failed to read resource", error instanceof Error ? error : undefined)
			throw new ResourceFetchError(uri, message, {
				server: serverName,
				cause: error instanceof Error ? error : undefined,
			})
		}

		const content = selectContent(result, uri)
		const mimeType = content.mimeType

		if (mimeType && !isHtmlMimeType(mimeType)) {
			log.warn("Unsupported MIME type", { mimeType })
			throw new ResourceParseError(
				uri,
				`unsupported MIME type "${mimeType}" (expected text/html or ${RESOURCE_MIME_TYPE})`,
				{ server: serverName, mimeType },
			)
		}

		const html = toHtml(content)
		if (!html.trim()) {
			log.warn("Resource content is empty")
			throw new ResourceParseError(uri, "content is empty", { server: serverName })
		}

		const contentMeta = extractUiMeta(content._meta)
		const listMeta = extractUiMeta(this.getListResourceMeta(serverName, uri))

		log.debug("Resource loaded successfully", {
			contentLength: html.length,
			hasCsp: !!contentMeta.csp || !!listMeta.csp,
		})

		return {
			uri: content.uri ?? uri,
			html,
			mimeType: mimeType ?? RESOURCE_MIME_TYPE,
			meta: {
				csp: contentMeta.csp ?? listMeta.csp,
				permissions: contentMeta.permissions ?? listMeta.permissions,
				domain: contentMeta.domain ?? listMeta.domain,
				prefersBorder: contentMeta.prefersBorder ?? listMeta.prefersBorder,
			},
		}
	}

	private getListResourceMeta(serverName: string, uri: string): Record<string, unknown> | undefined {
		const connection = this.manager.getConnection(serverName)
		if (!connection?.resources?.length) return undefined
		const resource = connection.resources.find((entry) => entry.uri === uri)
		if (!resource?._meta || typeof resource._meta !== "object") return undefined
		return resource._meta
	}
}

function selectContent(result: ReadResourceResult, preferredUri: string): ResourceContentRecord {
	const contents = (result.contents ?? []) as ResourceContentRecord[]
	if (contents.length === 0) {
		throw new Error(`No contents returned for UI resource: ${preferredUri}`)
	}

	const byUri = contents.find((content) => content.uri === preferredUri)
	if (byUri) return byUri

	const byHtmlMime = contents.find((content) => content.mimeType && isHtmlMimeType(content.mimeType))
	if (byHtmlMime) return byHtmlMime

	return contents[0]
}

function isHtmlMimeType(mimeType: string): boolean {
	const normalized = mimeType.toLowerCase()
	return normalized.startsWith("text/html") || normalized === RESOURCE_MIME_TYPE.toLowerCase()
}

function toHtml(content: ResourceContentRecord): string {
	if (typeof content.text === "string") {
		return content.text
	}

	if (typeof content.blob === "string") {
		return Buffer.from(content.blob, "base64").toString("utf-8")
	}

	throw new Error(`UI resource ${content.uri ?? "(unknown)"} did not include text or blob content`)
}

function extractUiMeta(meta: Record<string, unknown> | undefined): UiResourceMeta {
	if (!meta || typeof meta !== "object") return {}
	const ui = meta.ui as Record<string, unknown> | undefined
	if (!ui || typeof ui !== "object") return {}

	const out: UiResourceMeta = {}

	if (ui.csp && typeof ui.csp === "object") {
		out.csp = ui.csp as UiResourceMeta["csp"]
	}
	if (ui.permissions && typeof ui.permissions === "object") {
		out.permissions = ui.permissions as UiResourceMeta["permissions"]
	}
	if (typeof ui.domain === "string") {
		out.domain = ui.domain
	}
	if (typeof ui.prefersBorder === "boolean") {
		out.prefersBorder = ui.prefersBorder
	}

	return out
}
