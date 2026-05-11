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

export function buildVersionLine(theme: Theme): string {
	if (!cachedVersion) cachedVersion = getVersion()
	const dim = theme.getFgAnsi("dim")
	return `${dim}v${cachedVersion}${RST_FG}`
}

export function buildPathLine(theme: Theme): string {
	const dim = theme.getFgAnsi("dim")
	const branchColor = theme.getFgAnsi("mdLink")
	const branch = getGitBranch()
	const folder = getFolder()
	const branchPart = branch ? ` ${dim}·${RST_FG} ${branchColor}${branch}${RST_FG}` : ""
	return `${dim}${folder}${RST_FG}${branchPart}`
}
