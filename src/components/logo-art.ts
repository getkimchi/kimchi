import type { Theme } from "@earendil-works/pi-coding-agent"
import { RST_FG } from "../ansi.js"
import { getFolder, getGitBranch, getVersion } from "../utils.js"

let cachedVersion: string | undefined

export function buildLogoLines(theme: Theme): string[] {
	const L = theme.getFgAnsi("accent")
	const G = theme.getFgAnsi("bashMode")
	return [
		`${G}     █▀${RST_FG}  ${L}█  █ ▀█▀ █▄ ▄█ ▄▀▀ █  █ ▀█▀${RST_FG}`,
		`${L}    ███  █▀▄   █  █ ▀ █ █   █▀▀█  █${RST_FG}`,
		`${L}▄  ▄███  █  █  █  █   █ █▄▄ █  █  █${RST_FG}`,
		`${L}▀████▀   ▀  ▀ ▀▀▀ ▀   ▀  ▀▀ ▀  ▀ ▀▀▀${RST_FG}`,
	]
}

export function buildInfoLine(theme: Theme): string {
	if (!cachedVersion) cachedVersion = getVersion()
	const dim = theme.getFgAnsi("dim")
	const branchColor = theme.getFgAnsi("mdLink")
	const folder = getFolder()
	const branch = getGitBranch()
	const vdot = ` ${dim}·${RST_FG} `
	const branchPart = branch ? `${vdot}${branchColor}${branch}${RST_FG}` : ""
	return `${dim}v${cachedVersion}${RST_FG}${vdot}${dim}${folder}${RST_FG}${branchPart}`
}
