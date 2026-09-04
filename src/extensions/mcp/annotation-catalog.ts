import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Client, type ListToolsResult } from "@modelcontextprotocol/client"
import { computeServerHash, getMetadataCachePath } from "pi-mcp-adapter/metadata-cache"
import type { McpConfig } from "pi-mcp-adapter/types"
import { isReadOnlyMcpToolName } from "./read-only-tools.js"

type ListedTool = ListToolsResult["tools"][number]
type AnnotationState = "missing" | "read-only" | "not-read-only" | "conflict"

interface AnnotationCacheFile {
	version: 2
	sourceHash: string
	tools: Record<string, AnnotationState>
}

const CAPTURE_CONTEXT = new AsyncLocalStorage<McpAnnotationCatalog>()
const PATCH_MARKER = Symbol.for("kimchi.mcp.annotation-capture")
const CACHE_FILE = "mcp-annotations.json"

function toolKey(name: string, description = ""): string {
	return `${name}\0${description}`
}

function annotationState(tool: ListedTool): AnnotationState {
	if (tool.annotations?.readOnlyHint === true) return "read-only"
	if (tool.annotations?.readOnlyHint === false) return "not-read-only"
	return "missing"
}

function mergeState(current: AnnotationState | undefined, next: AnnotationState): AnnotationState {
	if (current === undefined || current === next) return next
	return "conflict"
}

function defaultCachePath(): string {
	return join(dirname(getMetadataCachePath()), CACHE_FILE)
}

export function mcpAnnotationSourceHash(config: Pick<McpConfig, "mcpServers">): string {
	const serverHashes = Object.entries(config.mcpServers)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, definition]) => [name, computeServerHash(definition)])
	return createHash("sha256").update(JSON.stringify(serverHashes)).digest("hex")
}

export class McpAnnotationCatalog {
	private readonly tools = new Map<string, AnnotationState>()
	private readonly cachePath: string
	private readonly sourceHash: string

	constructor(
		options: {
			cachePath?: string
			onChanged?: () => void
			sourceHash?: string
		} = {},
	) {
		this.cachePath = options.cachePath ?? defaultCachePath()
		this.onChanged = options.onChanged
		this.sourceHash = options.sourceHash ?? "unscoped"
		this.load()
	}

	private readonly onChanged: (() => void) | undefined

	record(tools: ListedTool[]): void {
		let changed = false
		for (const tool of tools) {
			if (!tool?.name) continue
			const key = toolKey(tool.name, tool.description)
			const next = mergeState(this.tools.get(key), annotationState(tool))
			if (this.tools.get(key) === next) continue
			this.tools.set(key, next)
			changed = true
		}
		if (!changed) return
		this.save()
		this.onChanged?.()
	}

	isReadOnly(originalName: string, description = ""): boolean {
		const state = this.tools.get(toolKey(originalName, description))
		return this.isReadOnlyState(originalName, state)
	}

	isReadOnlyByName(originalName: string): boolean {
		const prefix = `${originalName}\0`
		const states = [...this.tools].filter(([key]) => key.startsWith(prefix)).map(([, state]) => state)
		return states.length > 0 && states.every((state) => this.isReadOnlyState(originalName, state))
	}

	private isReadOnlyState(originalName: string, state: AnnotationState | undefined): boolean {
		if (state === "read-only") return true
		if (state === "missing") return isReadOnlyMcpToolName(originalName)
		return false
	}

	private load(): void {
		if (!existsSync(this.cachePath)) return
		try {
			const parsed = JSON.parse(readFileSync(this.cachePath, "utf8")) as Partial<AnnotationCacheFile>
			if (
				parsed.version !== 2 ||
				parsed.sourceHash !== this.sourceHash ||
				!parsed.tools ||
				typeof parsed.tools !== "object"
			)
				return
			for (const [key, state] of Object.entries(parsed.tools)) {
				if (["missing", "read-only", "not-read-only", "conflict"].includes(state)) {
					this.tools.set(key, state)
				}
			}
		} catch {
			// A damaged advisory cache must never block MCP startup. Unknown tools
			// remain excluded from read-only profiles until observed again.
		}
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.cachePath), { recursive: true })
			const temporaryPath = `${this.cachePath}.${process.pid}.${randomUUID()}.tmp`
			const payload: AnnotationCacheFile = {
				version: 2,
				sourceHash: this.sourceHash,
				tools: Object.fromEntries(this.tools),
			}
			writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 })
			renameSync(temporaryPath, this.cachePath)
		} catch (error) {
			console.warn(
				`[mcp] Failed to persist annotation cache: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
}

export function runWithMcpAnnotationCatalog<T>(catalog: McpAnnotationCatalog, callback: () => T): T {
	return CAPTURE_CONTEXT.run(catalog, callback)
}

/**
 * Observe the MCP SDK result before pi-mcp-adapter intentionally narrows its
 * public metadata. This changes neither requests nor responses; it only keeps
 * the protocol's readOnlyHint for Kimchi's planning policy.
 */
export function installMcpAnnotationCapture(): void {
	const prototype = Client.prototype as typeof Client.prototype & { [PATCH_MARKER]?: boolean }
	if (prototype[PATCH_MARKER]) return

	const originalListTools = prototype.listTools
	Object.defineProperty(prototype, "listTools", {
		configurable: true,
		value: async function (...args: Parameters<typeof originalListTools>): Promise<ListToolsResult> {
			const result = await originalListTools.apply(this, args)
			CAPTURE_CONTEXT.getStore()?.record(result.tools)
			return result
		},
	})
	prototype[PATCH_MARKER] = true
}
