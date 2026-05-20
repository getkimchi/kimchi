import type { MessageRenderer } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"
import { pr_dim, pr_teal } from "./colors.js"

interface BreadcrumbDetails {
	text: string
	/**
	 * Visual variant — controls the leading glyph and color.
	 * - "step"     → 🫧 dim   (default; scoping question announcements, generic breadcrumbs)
	 * - "answer"   → ⚗️ dim   (echoes of the user's scoping answers)
	 * - "ack"      → 🍺 teal  (ferment start / one-shot start / phase complete)
	 * - "warning"  → ⚠  dim   (worktree warnings, oneshot failure, step failure)
	 */
	variant?: "step" | "answer" | "ack" | "warning"
}

function glyphFor(variant: BreadcrumbDetails["variant"]): string {
	switch (variant) {
		case "ack":
			return pr_teal("🍺")
		case "warning":
			return pr_dim("⚠")
		case "answer":
			return pr_dim("⚗️")
		default:
			return pr_dim("🫧")
	}
}

export const fermentBreadcrumbRenderer: MessageRenderer<BreadcrumbDetails> = (message, _options, _theme) => {
	const d = message.details
	if (!d || !d.text) return undefined

	const container = new Container()
	const lines = d.text.split("\n")
	const glyph = glyphFor(d.variant)

	container.addChild(new Text(`${glyph}  ${pr_dim(lines[0] ?? "")}`, 0, 0))

	const indent = "    "
	for (let i = 1; i < lines.length; i++) {
		container.addChild(new Text(indent + pr_dim(lines[i] ?? ""), 0, 0))
	}

	return container
}
