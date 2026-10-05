import type { Api, Model } from "@earendil-works/pi-ai"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { humanizeContextWindow } from "./extensions/vision-support.js"

export interface ModelTableRow {
	model: Model<Api>
	id: string
	provider: string
	selected: boolean
	current?: boolean
	description: string
	annotation?: string
	warning?: boolean
}

/** Shared renderer for /model and the inline vision switch, including narrow
 * terminals and Unicode cell widths. The first returned line is the header. */
export function renderModelTable(
	rows: ModelTableRow[],
	width: number,
	theme: Pick<Theme, "fg">,
	vision = false,
): string[] {
	if (rows.length === 0) return []
	const clip = (text: string, cells: number) => truncateToWidth(text, Math.max(0, cells), "…")
	const pad = (text: string, cells: number) => {
		const clipped = clip(text, cells)
		return clipped + " ".repeat(Math.max(0, cells - visibleWidth(clipped)))
	}
	const dim = (text: string) => theme.fg("muted", text)
	const gutter = vision ? 4 : 3
	const context = (row: ModelTableRow) => humanizeContextWindow(row.model.contextWindow)
	const contextW = Math.max(7, ...rows.map((row) => visibleWidth(context(row))))
	const fixed = gutter + contextW + (vision ? 6 : 0) + (vision ? 6 : 4)
	// Compaction must stay visible even when the description column disappears.
	const warningReserve = rows.some((row) => row.warning) ? 3 : 0
	const available = width - fixed - warningReserve
	const cursor = (row: ModelTableRow) =>
		(vision ? "" : " ") +
		(row.selected ? theme.fg("accent", "→ ") : "  ") +
		(vision ? (row.current ? theme.fg("accent", "✓ ") : "  ") : "")
	if (available < 7) {
		return [
			clip(dim(`${" ".repeat(gutter)}MODEL`), width),
			...rows.map((row) => {
				const marker = row.warning ? ` ${theme.fg("warning", "⚠")}` : ""
				return truncateToWidth(cursor(row) + clip(row.id, width - gutter - visibleWidth(marker)) + marker, width, "")
			}),
		]
	}
	const maxId = Math.max(5, ...rows.map((row) => visibleWidth(row.id)))
	const maxProvider = Math.max(8, ...rows.map((row) => visibleWidth(row.provider)))
	const providerW = Math.min(maxProvider, Math.max(3, available - Math.min(maxId, 24)))
	const modelW = Math.min(maxId, available - providerW)
	const descW = Math.max(0, width - fixed - modelW - providerW - 2)
	const showDesc = descW >= 4
	const header =
		" ".repeat(gutter) +
		pad("MODEL", modelW) +
		"  " +
		pad("PROVIDER", providerW) +
		"  " +
		pad("CONTEXT", contextW) +
		(vision ? "  VISION" : "") +
		(showDesc ? `  ${clip("DESCRIPTION", descW)}` : "")
	const lines = [dim(header)]
	for (const row of rows) {
		let description = ""
		if (row.warning && !showDesc) {
			description = `  ${theme.fg("warning", "⚠")}`
		} else if (showDesc) {
			const annotation = row.annotation ?? ""
			if (row.warning && annotation) {
				const annotationW = Math.min(visibleWidth(annotation), descW)
				const remaining = descW - annotationW - 3
				description =
					theme.fg("warning", clip(annotation, annotationW)) +
					(row.description && remaining >= 4 ? dim(` · ${clip(row.description, remaining)}`) : "")
			} else {
				description = dim(clip([annotation, row.description].filter(Boolean).join(" "), descW))
			}
			description = `  ${description}`
		}
		const id = pad(row.id, modelW)
		const visionCell = vision ? `  ${row.model.input.includes("image") ? "✓" : theme.fg("warning", "✗")}     ` : ""
		lines.push(
			cursor(row) +
				(row.selected ? theme.fg("accent", id) : theme.fg("text", id)) +
				"  " +
				dim(pad(row.provider, providerW)) +
				"  " +
				dim(pad(context(row), contextW)) +
				visionCell +
				description,
		)
	}
	return lines.map((line) => truncateToWidth(line, width, ""))
}

/** The patched dependency cannot import harness source; this adapter is loaded
 * by the CLI and shared with the vision selector through normal imports. */
export function installModelTableRenderer(): void {
	const globals = process as typeof process & { __kimchiRenderModelTable?: typeof renderModelTable }
	globals.__kimchiRenderModelTable = renderModelTable
}
