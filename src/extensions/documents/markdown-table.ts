/**
 * Markdown table rendering shared by all extractors.
 * Cells are sanitized: pipes escaped, newlines flattened, so one logical
 * cell never breaks the row or leaks a second table row.
 */

export function escapeMarkdownCell(value: string): string {
	return value
		.replace(/\|/g, "\\|")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
}

/** Render a header + body as a GitHub-flavored markdown table. */
export function renderMarkdownTable(header: string[], rows: string[][]): string {
	if (header.length === 0) return ""
	const lines = [`| ${header.map(escapeMarkdownCell).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`]
	for (const row of rows) {
		lines.push(`| ${row.map(escapeMarkdownCell).join(" | ")} |`)
	}
	return lines.join("\n")
}
