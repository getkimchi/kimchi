import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { PromptMode } from "./system-prompt.js"

export interface SystemPromptBlocksHandle {
	register(block: SystemPromptBlock): void
}

export interface SystemPromptBlock {
	id: string
	render(ctx: SystemPromptBlockContext): string | undefined
	suppress?(ctx: SystemPromptBlockContext): ReadonlySet<SuppressibleSection> | undefined
}

export type SuppressibleSection = "orchestration" | "phase-guidelines" | "project-context" | "skills"

export interface SystemPromptBlockContext {
	mode: PromptMode
}

export interface RenderedSystemPromptBlock {
	owner: string
	id: string
	content: string
	suppress: ReadonlySet<SuppressibleSection>
}

class BlocksHandle implements SystemPromptBlocksHandle {
	private readonly blocks = new Map<string, SystemPromptBlock>()

	constructor(
		readonly pi: ExtensionAPI,
		readonly owner: string,
	) {}

	register(block: SystemPromptBlock): void {
		this.blocks.set(block.id, block)
	}

	render(ctx: SystemPromptBlockContext): RenderedSystemPromptBlock[] {
		const rendered: RenderedSystemPromptBlock[] = []
		for (const block of this.blocks.values()) {
			let rawContent: string | undefined
			try {
				rawContent = block.render(ctx)
			} catch (err) {
				console.warn(`system-prompt-blocks: ${this.owner}/${block.id} render failed: ${formatError(err)}`)
				continue
			}
			if (rawContent === undefined) continue
			const content = rawContent.trim()
			if (content === "") continue
			let suppress: ReadonlySet<SuppressibleSection> = new Set()
			try {
				suppress = block.suppress?.(ctx) ?? suppress
			} catch (err) {
				console.warn(`system-prompt-blocks: ${this.owner}/${block.id} suppress failed: ${formatError(err)}`)
			}
			rendered.push({
				owner: this.owner,
				id: block.id,
				content,
				suppress,
			})
		}
		return rendered
	}
}

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

interface PiRecord {
	handles: Set<BlocksHandle>
}

const recordsByPi = new WeakMap<ExtensionAPI, PiRecord>()
const activeRecords = new Set<PiRecord>()

function getRecord(pi: ExtensionAPI): PiRecord {
	let record = recordsByPi.get(pi)
	if (!record) {
		record = { handles: new Set() }
		recordsByPi.set(pi, record)
		activeRecords.add(record)
		const recordForHandler = record
		pi.on("session_shutdown", () => {
			recordsByPi.delete(pi)
			activeRecords.delete(recordForHandler)
			recordForHandler.handles.clear()
		})
	}
	return record
}

export function createSystemPromptBlocks(pi: ExtensionAPI, owner: string): SystemPromptBlocksHandle {
	const handle = new BlocksHandle(pi, owner)
	getRecord(pi).handles.add(handle)
	return handle
}

export function renderSystemPromptBlocks(ctx: SystemPromptBlockContext): RenderedSystemPromptBlock[] {
	const rendered: RenderedSystemPromptBlock[] = []
	for (const record of activeRecords) {
		for (const handle of record.handles) {
			rendered.push(...handle.render(ctx))
		}
	}
	return rendered.sort((a, b) => {
		const owner = a.owner.localeCompare(b.owner)
		if (owner !== 0) return owner
		const id = a.id.localeCompare(b.id)
		return id
	})
}
