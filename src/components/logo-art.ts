import type { Theme } from "@earendil-works/pi-coding-agent"
import { RST_FG } from "../ansi.js"
import { DEFAULT_VARIANT, resolvePromptVariant } from "../extensions/prompt-construction/variants/index.js"
import { getFolder, getGitBranch, getVersion } from "../utils.js"

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

// The pepper mark columns, shared by the full word-art and the compact
// variant so the two can't drift apart.
const PEPPER_ROWS = ["     █▀", "    ███", "▄  ▄███", "▀████▀"]

// The "kimchi" word-art columns that follow the pepper in the full logo.
const WORD_ROWS = [
	"  █  █ ▀█▀ █▄ ▄█ ▄▀▀ █  █ ▀█▀",
	"  █▀▄   █  █ ▀ █ █   █▀▀█  █",
	"  █  █  █  █   █ █▄▄ █  █  █",
	"   ▀  ▀ ▀▀▀ ▀   ▀  ▀▀ ▀  ▀ ▀▀▀",
]

const FIRE_COLORS = ["\x1b[38;5;196m", "\x1b[38;5;202m", "\x1b[38;5;208m", "\x1b[38;5;214m"]

// The spicy variant burns the same rows in a fire gradient instead of the
// theme colours, so all logo variants stay built from one set of glyphs.
function buildBurningLogoLines(): string[] {
	return PEPPER_ROWS.map((pepper, i) => `${FIRE_COLORS[i]}${pepper}${WORD_ROWS[i]}${RST_FG}`)
}

export function buildLogoLines(theme: Theme): string[] {
	const variant = resolvePromptVariant()
	if (variant.name !== DEFAULT_VARIANT.name) return buildBurningLogoLines()

	const L = theme.getFgAnsi("accent")
	const G = theme.getFgAnsi("bashMode")
	return [
		`${G}${PEPPER_ROWS[0]}${RST_FG}${L}${WORD_ROWS[0]}${RST_FG}`,
		...PEPPER_ROWS.slice(1).map((pepper, i) => `${L}${pepper}${WORD_ROWS[i + 1]}${RST_FG}`),
	]
}

/**
 * Pepper-only variant of the logo art for narrow terminals where the full
 * word-art would leave no room for the rest of the header.
 */
export function buildCompactLogoLines(theme: Theme): string[] {
	const L = theme.getFgAnsi("accent")
	const G = theme.getFgAnsi("bashMode")
	return [`${G}${PEPPER_ROWS[0]}${RST_FG}`, ...PEPPER_ROWS.slice(1).map((pepper) => `${L}${pepper}${RST_FG}`)]
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
		lines.push(`${theme.getFgAnsi("accent")}variant ${variant.tagline ?? variant.name}${RST_FG}`)
	}
	return lines
}
