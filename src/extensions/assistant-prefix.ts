import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Markdown, visibleWidth } from "@earendil-works/pi-tui"
import type { MarkdownTheme } from "@earendil-works/pi-tui"

const PATCH_SYMBOL = Symbol("kimchi:dotted-paragraph")

/** Wraps a Markdown block with a ` ● ` prefix on the first visible line, `   ` on the rest. */
class DottedParagraph {
	private md: Markdown
	private cachedWidth?: number
	private cachedLines?: string[]

	constructor(text: string, markdownTheme: MarkdownTheme) {
		this.md = new Markdown(text, 0, 0, markdownTheme)
	}

	invalidate(): void {
		this.cachedWidth = undefined
		this.cachedLines = undefined
		this.md.invalidate()
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines
		const PREFIX_W = 3
		if (width <= PREFIX_W) {
			this.cachedWidth = width
			this.cachedLines = [" ● "]
			return this.cachedLines
		}
		const lines = this.md.render(width - PREFIX_W)
		let dotPlaced = false
		const rendered = lines.map((line: string) => {
			if (!dotPlaced && visibleWidth(line) > 0) {
				dotPlaced = true
				return ` ● ${line}`
			}
			return `   ${line}`
		})
		this.cachedWidth = width
		this.cachedLines = rendered
		return rendered
	}
}

function installPatch(): void {
	const proto = AssistantMessageComponent.prototype as unknown as {
		updateContent: (message: unknown) => void
		contentContainer: { children: unknown[] }
		markdownTheme: MarkdownTheme
	} & Record<symbol, boolean>

	const currentFn = proto.updateContent as unknown as Record<symbol, boolean>
	if (currentFn[PATCH_SYMBOL]) return

	const origFn = proto.updateContent

	function patched(this: typeof proto, message: unknown): void {
		origFn.call(this, message)
		const container = this.contentContainer
		if (!container?.children) return
		const mdTheme = this.markdownTheme
		for (let i = 0; i < container.children.length; i++) {
			const child = container.children[i]
			if (child instanceof Markdown) {
				const text = (child as unknown as { text?: string }).text
				if (!text) continue
				container.children[i] = new DottedParagraph(text, mdTheme)
			}
		}
	}
	;(patched as unknown as Record<symbol, boolean>)[PATCH_SYMBOL] = true

	proto.updateContent = patched
}

export default function assistantPrefixExtension(_pi: ExtensionAPI) {
	installPatch()
}
