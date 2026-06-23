import type { Theme } from "@earendil-works/pi-coding-agent"
import { RST_FG } from "../ansi.js"
import { DEFAULT_VARIANT, resolvePromptVariant } from "../extensions/prompt-construction/variants/index.js"
import { getFolder, getGitBranch, getVersion } from "../utils.js"

const LOGO_GLYPHS = [
	"     █▀  █  █ ▀█▀ █▄ ▄█ ▄▀▀ █  █ ▀█▀",
	"    ███  █▀▄   █  █ ▀ █ █   █▀▀█  █",
	"▄  ▄███  █  █  █  █   █ █▄▄ █  █  █",
	"▀████▀   ▀  ▀ ▀▀▀ ▀   ▀  ▀▀ ▀  ▀ ▀▀▀",
]

const FIRE_COLORS = ["\x1b[38;5;196m", "\x1b[38;5;202m", "\x1b[38;5;208m", "\x1b[38;5;214m"]

function buildBurningLogoLines(): string[] {
	return LOGO_GLYPHS.map((glyph, i) => `${FIRE_COLORS[i]}${glyph}${RST_FG}`)
}

let cachedVersion: string | undefined

/** Truncate a file-system path to fit `maxWidth` while preserving the basename. */
export function truncatePath(path: string, maxWidth: number): string {
	if (path.length <= maxWidth) return path

	const lastSlash = path.lastIndexOf("/")
	if (lastSlash <= 0 || lastSlash >= path.length - 1) {
		return `${path.slice(0, Math.max(0, maxWidth - 3))}...`
	}

	const dir = path.slice(0, lastSlash)
	const basename = path.slice(lastSlash + 1)
	const ellipsis = "..."
	const sep = "/"
	const minPrefixLen = 1

	// Try: dirPrefix + ".../" + basename
	for (
		let prefixLen = Math.min(dir.length, maxWidth - ellipsis.length - sep.length - basename.length);
		prefixLen >= minPrefixLen;
		prefixLen--
	) {
		const candidate = dir.slice(0, prefixLen) + ellipsis + sep + basename
		if (candidate.length <= maxWidth) return candidate
	}

	// Fall back to simple right truncation
	return `${path.slice(0, Math.max(0, maxWidth - 3))}...`
}

export function buildLogoLines(theme: Theme): string[] {
	const variant = resolvePromptVariant()
	if (variant.name !== DEFAULT_VARIANT.name) return buildBurningLogoLines()

	const L = theme.getFgAnsi("accent")
	const G = theme.getFgAnsi("bashMode")
	return [
		`${G}     █▀${RST_FG}  ${L}█  █ ▀█▀ █▄ ▄█ ▄▀▀ █  █ ▀█▀${RST_FG}`,
		`${L}    ███  █▀▄   █  █ ▀ █ █   █▀▀█  █${RST_FG}`,
		`${L}▄  ▄███  █  █  █  █   █ █▄▄ █  █  █${RST_FG}`,
		`${L}▀████▀   ▀  ▀ ▀▀▀ ▀   ▀  ▀▀ ▀  ▀ ▀▀▀${RST_FG}`,
	]
}

export function buildInfoLines(
	theme: Theme,
	{ folderMaxWidth, getBranch }: { folderMaxWidth?: number; getBranch?(): string | undefined } = {},
): string[] {
	if (!cachedVersion) cachedVersion = getVersion()
	const dim = theme.getFgAnsi("dim")
	const branchColor = theme.getFgAnsi("mdLink")
	let folder = getFolder()
	if (folderMaxWidth !== undefined && folder.length > folderMaxWidth) {
		folder = truncatePath(folder, folderMaxWidth)
	}
	const branch = getBranch ? getBranch() : getGitBranch()
	const vdot = ` ${dim}·${RST_FG} `
	const lines: string[] = [`${dim}v${cachedVersion}${RST_FG}${vdot}${dim}${folder}${RST_FG}`]
	if (branch) {
		lines.push(`${branchColor}${branch}${RST_FG}`)
	}
	const variant = resolvePromptVariant()
	if (variant.name !== DEFAULT_VARIANT.name) {
		lines.push(`\x1b[38;5;208mvariant ${variant.tagline ?? variant.name}${RST_FG}`)
	}
	return lines
}
