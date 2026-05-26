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

// Each extension receives a unique ExtensionAPI object from pi-mono's loader, so
// blocks must be visible across pis (the renderer's pi differs from the registrar's).
// One slot per pi; the slot is dropped when that pi's session shuts down — naturally
// isolates parent vs. subagent sessions without reference counting.
const handlesByPi = new Map<ExtensionAPI, Set<BlocksHandle>>()

export function createSystemPromptBlocks(pi: ExtensionAPI, owner: string): SystemPromptBlocksHandle {
	const handle = new BlocksHandle(pi, owner)
	let handles = handlesByPi.get(pi)
	if (!handles) {
		handles = new Set()
		handlesByPi.set(pi, handles)
		pi.on("session_shutdown", () => {
			handlesByPi.delete(pi)
		})
	}
	handles.add(handle)
	return handle
}

export function renderSystemPromptBlocks(
	_pi: ExtensionAPI,
	ctx: SystemPromptBlockContext,
): RenderedSystemPromptBlock[] {
	const rendered: RenderedSystemPromptBlock[] = []
	for (const handles of handlesByPi.values()) {
		for (const handle of handles) rendered.push(...handle.render(ctx))
	}
	return rendered.sort((a, b) => {
		if (a.owner < b.owner) return -1
		if (a.owner > b.owner) return 1
		if (a.id < b.id) return -1
		if (a.id > b.id) return 1
		return 0
	})
}
