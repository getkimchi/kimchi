import { RST, TRUECOLOR } from "../ansi.js"
import { formatModelPair } from "../integrations/models.js"
import type { ToolId } from "../integrations/types.js"

/**
 * Print the small kimchi banner before launching a tool subcommand
 * (`kimchi claude`, `kimchi opencode`, …). It states which tool we're
 * configuring, the model pair, GSD status, and config mode so the user
 * has a quick at-a-glance summary before the tool boots.
 *
 * If `availableModels` is provided, the model pair is rendered dynamically
 * from the live API list. Otherwise falls back to "dynamic models" placeholder.
 */
export interface BannerSummary {
	toolId: ToolId
	gsdActive: boolean
	mode: "inject" | "override"
	availableModels?: readonly import("../models.js").ModelMetadata[]
}

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
// 256-color red used when truecolor isn't available.
const RED_256 = "38;5;196"
// Pure red for truecolor terminals.
const RED_TRUE = "38;2;255;0;0"
const RED_OPEN = TRUECOLOR ? `\x1b[${RED_TRUE}m` : `\x1b[${RED_256}m`

function colorEnabled(): boolean {
	if ("NO_COLOR" in process.env) return false
	if (process.env.WT_SESSION || process.env.COLORTERM) return true
	const term = process.env.TERM ?? ""
	return term !== "" && term !== "dumb"
}

export function renderBanner(summary: BannerSummary): string {
	const line = "─".repeat(45)
	const models = summary.availableModels ? formatModelPair(summary.availableModels) : "dynamic models"
	const gsd = summary.gsdActive ? "active" : "not installed"

	if (!colorEnabled()) {
		return [
			"",
			"  kimchi",
			`  ${"-".repeat(45)}`,
			`  Target:  ${summary.toolId}`,
			`  Models:  ${models}`,
			`  GSD:     ${gsd}`,
			`  Mode:    ${summary.mode}`,
			`  ${"-".repeat(45)}`,
			"",
		].join("\n")
	}

	const dimLabel = (text: string) => `${DIM}${text}${RST}`
	const dimLine = `${DIM}${line}${RST}`
	const header = `${BOLD}${RED_OPEN}🌶️  kimchi${RST}`

	return [
		"",
		`  ${header}`,
		`  ${dimLine}`,
		`  ${dimLabel("Target:")}  ${summary.toolId}`,
		`  ${dimLabel("Models:")}  ${models}`,
		`  ${dimLabel("GSD:")}     ${gsd}`,
		`  ${dimLabel("Mode:")}    ${summary.mode}`,
		`  ${dimLine}`,
		"",
	].join("\n")
}

export function printBanner(summary: BannerSummary): void {
	process.stdout.write(renderBanner(summary))
}
