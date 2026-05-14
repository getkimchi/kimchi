// Copy non-TypeScript resources that tsc doesn't handle.
//
// --dev   (used by `build`):        theme files from node_modules → src/modes/interactive/theme/
//                                   export-html templates → src/core/export-html/
//                                   so `bun run src/cli.ts` resolves assets via pi-mono's getters
//                                   (getThemesDir, getExportTemplateDir) relative to kimchi's project root
//
// default (used by `build-binary`): theme files from node_modules → dist/share/kimchi/theme/
//                                   export-html templates → dist/share/kimchi/export-html/
//                                   plus package.json → dist/share/kimchi/
//                                   so the compiled binary resolves assets from the shared data directory

import { cpSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const piAgentDist = join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist")

const themeFiles = ["dark.json", "light.json", "theme-schema.json"]
const themeSrc = join(piAgentDist, "modes", "interactive", "theme")

// Skip TypeScript declarations and source maps when staging export-html — only template.{html,css,js}
// and vendor/*.min.js are read at runtime, so .d.ts/.map files are pure payload bloat.
const exportHtmlSkipSuffixes = [".d.ts", ".d.ts.map", ".js.map"]
const exportHtmlSrc = join(piAgentDist, "core", "export-html")

const isDev = process.argv.includes("--dev")
const themeDest = isDev
	? join(projectRoot, "src", "modes", "interactive", "theme")
	: join(projectRoot, "dist", "share", "kimchi", "theme")
const exportHtmlDest = isDev
	? join(projectRoot, "src", "core", "export-html")
	: join(projectRoot, "dist", "share", "kimchi", "export-html")

mkdirSync(themeDest, { recursive: true })
for (const file of themeFiles) {
	cpSync(join(themeSrc, file), join(themeDest, file))
}

cpSync(exportHtmlSrc, exportHtmlDest, {
	recursive: true,
	filter: (src) => !exportHtmlSkipSuffixes.some((suffix) => src.endsWith(suffix)),
})

// kimchi's own themes live outside node_modules — copy them alongside the upstream themes
const kimchiThemesSrc = join(projectRoot, "themes")
const kimchiThemeFiles = readdirSync(kimchiThemesSrc).filter((f) => f.endsWith(".json"))
for (const file of kimchiThemeFiles) {
	cpSync(join(kimchiThemesSrc, file), join(themeDest, file))
}

if (!isDev) {
	cpSync(join(projectRoot, "package.json"), join(projectRoot, "dist", "share", "kimchi", "package.json"))
}
