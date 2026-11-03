#!/usr/bin/env node
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

import { execFileSync } from "node:child_process"
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { platform, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyTemplateFixes, TEMPLATE_FIX_ANCHORS } from "./export-template-fixes.js"

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const piAgentDist = join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist")

// upstream pi no longer ships theme-schema.json in dist (hosted at
// https://pi.dev/schemas/theme.schema.json instead) — only the two built-in
// theme palettes are staged.
const themeFiles = ["dark.json", "light.json"]
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

// Post-process the staged export template: replace the three recursive tree
// walkers (sortChildren, mapNodes, markActive) with iterative versions. Long
// sessions form ~14k-deep parentId chains and the recursive walkers overflow
// the browser call stack, leaving the export blank except for kimchi's
// injected divs. Fail-soft (warn-and-skip on anchor drift so a pi-mono upgrade
// never breaks the build); the vitest conformance test against the installed
// upstream template is the drift tripwire that forces a human decision.
const templateJsPath = join(exportHtmlDest, "template.js")
const templateFixes = applyTemplateFixes(readFileSync(templateJsPath, "utf-8"))
if (templateFixes.applied < TEMPLATE_FIX_ANCHORS.length || templateFixes.warnings.length > 0) {
	console.warn(
		`[copy-resources] export template fixes: applied ${templateFixes.applied}/${TEMPLATE_FIX_ANCHORS.length} — ` +
			"recursive tree walkers may still overflow the browser stack on long sessions",
	)
	for (const warning of templateFixes.warnings) {
		console.warn(`[copy-resources] ${warning}`)
	}
}
writeFileSync(templateJsPath, templateFixes.js, "utf-8")

// Post-process export HTML template to inject the kimchi version number.
const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"))
// Match src/utils.ts getVersion() mapping (0.0.0 → "dev").
const appVersion = pkg.version && pkg.version !== "0.0.0" ? pkg.version : "dev"
// Inject a single inline script just before </body> that sets the version
// and dynamically patches the DOM after renderHeader() has already run.
// renderHeader() stays upstream code, so this survives template.js refactors.
const templateHtmlPath = join(exportHtmlDest, "template.html")
let templateHtml = readFileSync(templateHtmlPath, "utf-8")
templateHtml = templateHtml.replace(
	"</body>",
	`<script>
(function() {
  window.__KIMCHI_VERSION = ${JSON.stringify(appVersion)};
  const container = document.querySelector('.header-info');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'info-item';
  el.innerHTML = '<span class="info-label">Version:</span><span class="info-value">' + window.__KIMCHI_VERSION + '</span>';
  container.appendChild(el);
})();
</script>
</body>`,
)
writeFileSync(templateHtmlPath, templateHtml, "utf-8")

// kimchi's own themes live outside node_modules — copy them alongside the upstream themes
const kimchiThemesSrc = join(projectRoot, "themes")
const kimchiThemeFiles = readdirSync(kimchiThemesSrc).filter((f) => f.endsWith(".json"))
for (const file of kimchiThemeFiles) {
	cpSync(join(kimchiThemesSrc, file), join(themeDest, file))
}

if (!isDev) {
	cpSync(join(projectRoot, "package.json"), join(projectRoot, "dist", "share", "kimchi", "package.json"))

	// Stage bundled skills (resources/skills) so the central skill-root
	// resolver finds them via resolveAuxiliaryFilesDir in the compiled binary.
	const bundledSkillsSrc = join(projectRoot, "resources", "skills")
	const bundledSkillsDest = join(projectRoot, "dist", "share", "kimchi", "skills")
	if (existsSync(bundledSkillsSrc)) {
		mkdirSync(bundledSkillsDest, { recursive: true })
		cpSync(bundledSkillsSrc, bundledSkillsDest, { recursive: true })
	}

	// Copy custom OAuth page templates
	const oauthSrc = join(projectRoot, "resources", "oauth")
	const oauthDest = join(projectRoot, "dist", "share", "kimchi", "oauth")
	mkdirSync(oauthDest, { recursive: true })
	cpSync(oauthSrc, oauthDest, { recursive: true })

	// Copy proxy-helper binary built by scripts/build-proxy-helper.js.
	const buildTargetOS = process.env.KIMCHI_BUILD_TARGET_OS || platform()
	const proxyHelperName = buildTargetOS === "win32" || buildTargetOS === "windows" ? "proxy-helper.exe" : "proxy-helper"
	const proxyHelperSrc = join(projectRoot, "tools", "proxy-helper", "bin", proxyHelperName)
	const proxyHelperBinDest = join(projectRoot, "dist", "share", "kimchi", "bin")
	if (!existsSync(proxyHelperSrc)) {
		throw new Error(`proxy-helper binary not found: ${proxyHelperSrc}`)
	}
	mkdirSync(proxyHelperBinDest, { recursive: true })
	cpSync(proxyHelperSrc, join(proxyHelperBinDest, proxyHelperName))
}

// Bundle each document skill's CLI with one shared recipe: stage the skill's
// documents module tree under a temp dir, stage the runtime deps AND their
// transitive trees flat into the staging node_modules (pnpm nests them;
// children resolve via a require anchored at their parent's real manifest),
// build with bun, and move the bundle into place. Staging under the system
// temp dir keeps bun away from ancestors a sandbox can't read, and
// dereferences pnpm's symlinks at the same time.
function cleanup(dir) {
	// Best-effort: cleanup must never mask a build error — a stale temp dir is
	// the accepted worst case.
	try {
		rmSync(dir, { recursive: true, force: true })
	} catch {
		// ignore — the OS reclaims temp dirs
	}
}

function stageDocuments(staging, entryName) {
	const stagedEntry = join(staging, entryName)
	cpSync(join(projectRoot, "src", "extensions", "documents", entryName), stagedEntry)
	// The entry imports its siblings — stage the whole module tree and rewrite
	// the entry's relative imports at it.
	cpSync(join(projectRoot, "src", "extensions", "documents"), join(staging, "documents"), {
		recursive: true,
		filter: (src) => !src.endsWith(".test.ts"),
	})
	const entry = readFileSync(stagedEntry, "utf-8")
	writeFileSync(stagedEntry, entry.replaceAll('from "./', 'from "./documents/'))
	return stagedEntry
}

function stageDeps(staging, roots) {
	const stagedPkgs = new Set()
	const stageDep = (name, anchor) => {
		if (stagedPkgs.has(name)) return
		stagedPkgs.add(name)
		const requireFrom = createRequire(anchor ?? join(projectRoot, "package.json"))
		let realPkg
		try {
			realPkg = realpathSync(requireFrom.resolve(`${name}/package.json`))
		} catch {
			// package.json not exported (e.g. marked): anchor to the main entry
			// and walk up to its manifest.
			let dir = dirname(realpathSync(requireFrom.resolve(name)))
			while (!existsSync(join(dir, "package.json"))) {
				const up = dirname(dir)
				if (up === dir) throw new Error(`no package.json above ${name}`)
				dir = up
			}
			realPkg = join(dir, "package.json")
		}
		cpSync(dirname(realPkg), join(staging, "node_modules", name), { dereference: true, recursive: true })
		const manifest = JSON.parse(readFileSync(realPkg, "utf-8"))
		for (const child of Object.keys(manifest.dependencies ?? {})) {
			try {
				stageDep(child, realPkg)
			} catch {
				// optional dep not installed — bundling fails loudly if it's truly needed
			}
		}
	}
	for (const dep of roots) {
		stageDep(dep)
	}
}

// jszip's package root resolves lib/index.js (→ lie, pako, … not staged); its
// dist/jszip.min.js is self-contained, so point the staged manifest at it.
function pointJszipAtSelfContainedDist(staging) {
	const jszipPkgPath = join(staging, "node_modules", "jszip", "package.json")
	const jszipPkg = JSON.parse(readFileSync(jszipPkgPath, "utf-8"))
	jszipPkg.main = "dist/jszip.min.js"
	writeFileSync(jszipPkgPath, JSON.stringify(jszipPkg))
}

function bundleSkillCli({ skill, entry, deps, rewriteJszip = false }) {
	const cliDest = join(projectRoot, isDev ? "resources" : "dist/share/kimchi", `skills/${skill}/scripts/${skill}.mjs`)
	mkdirSync(dirname(cliDest), { recursive: true })
	const staging = mkdtempSync(join(tmpdir(), `kimchi-${skill}-build-`))
	try {
		const stagedEntry = stageDocuments(staging, entry)
		stageDeps(staging, deps)
		if (rewriteJszip) pointJszipAtSelfContainedDist(staging)
		const stagedOut = join(staging, `${skill}.mjs`)
		execFileSync("bun", ["build", stagedEntry, "--target=node", "--format=esm", "--outfile", stagedOut], {
			stdio: "inherit",
		})
		cpSync(stagedOut, cliDest)
		return cliDest
	} finally {
		cleanup(staging)
	}
}

// pdf: unpdf/@cantoo/pdf-lib are dependency graphs pnpm nests. Fonts are
// discovered on the host at runtime (pdf-fonts.ts scans the OS font dirs).
const pdfCliDest = bundleSkillCli({
	skill: "pdf",
	entry: "pdf-cli.ts",
	deps: ["@cantoo/pdf-lib", "@pdf-lib/fontkit", "unpdf", "marked", "@hyzyla/pdfium"],
})
{
	// The LO-edit macro ships beside the CLI: the CLI stages it into a
	// throwaway LibreOffice profile at run time. In dev mode the skill dir
	// IS the source dir, so the copy would be src === dest — skip it.
	const lodrawSrc = join(projectRoot, "resources", "skills", "pdf", "scripts", "lodraw_edit.py")
	const lodrawDest = join(dirname(pdfCliDest), "lodraw_edit.py")
	if (resolve(lodrawSrc) !== resolve(lodrawDest)) {
		cpSync(lodrawSrc, lodrawDest)
	}
	// Same self-copy guard for the bundled PDFium WASM used by render's
	// in-process core route.
	const requireFrom = createRequire(join(projectRoot, "package.json"))
	const wasmSrc = realpathSync(requireFrom.resolve("@hyzyla/pdfium/pdfium.wasm"))
	const wasmDest = join(dirname(pdfCliDest), "pdfium.wasm")
	if (resolve(wasmSrc) !== resolve(wasmDest)) {
		cpSync(wasmSrc, wasmDest)
	}
}

// docx: stage the `docx` dependency graph (jszip, nanoid, hash.js).
bundleSkillCli({
	skill: "docx",
	entry: "docx-cli.ts",
	deps: ["docx", "@xmldom/xmldom", "jszip", "marked", "yauzl"],
	rewriteJszip: true,
})

// xlsx: the jszip/@xmldom/yauzl graph the extractor/editor needs.
bundleSkillCli({
	skill: "xlsx",
	entry: "xlsx-cli.ts",
	deps: ["@xmldom/xmldom", "jszip", "yauzl"],
	rewriteJszip: true,
})

// pptx: @xmldom/xmldom and image-size are dependency-free; pptxgenjs depends
// only on jszip/image-size, and yauzl pulls pend — nested deps resolve through
// the graph walk anchored at each parent's manifest.
bundleSkillCli({
	skill: "pptx",
	entry: "pptx-cli.ts",
	deps: ["@xmldom/xmldom", "pptxgenjs", "marked", "yauzl", "jszip"],
	rewriteJszip: true,
})

// Bundle YAML into the validator: discovered skills are copied to temporary
// directories, and installed binaries have no node_modules to resolve it from.
//
// Build inside a temp staging dir instead of in place: bun scans every ancestor
// directory of its entry path hunting for workspace context, which fails under
// sandboxes that don't grant the home directory. Staging under the
// system temp dir keeps the whole ancestor chain readable; the bundle is moved
// into the repo afterwards.
const validatorDest = join(
	projectRoot,
	isDev ? "resources" : "dist/share/kimchi",
	"skills/create-skill/scripts/validate-skill.mjs",
)
mkdirSync(dirname(validatorDest), { recursive: true })
const stagingRoot = mkdtempSync(join(tmpdir(), "kimchi-validate-build-"))
try {
	const stagedEntry = join(stagingRoot, "validate-skill.ts")
	const stagedYaml = join(stagingRoot, "node_modules", "yaml")
	cpSync(join(projectRoot, "src/shared/skill-discovery/validate-skill.ts"), stagedEntry)
	// Dereference pnpm's symlink so bun resolves "yaml" without walking the real
	// package's path back into the repo.
	cpSync(join(projectRoot, "node_modules", "yaml"), stagedYaml, { dereference: true, recursive: true })
	const stagedOut = join(stagingRoot, "validate-skill.mjs")
	execFileSync("bun", ["build", stagedEntry, "--target=node", "--format=esm", "--minify", "--outfile", stagedOut], {
		stdio: "inherit",
	})
	cpSync(stagedOut, validatorDest)
} finally {
	// Best-effort: cleanup must never mask a build error or fail the build once
	// the bundle is in place — a stale temp dir is the accepted worst case.
	try {
		rmSync(stagingRoot, { recursive: true, force: true })
	} catch {
		// ignore — the OS reclaims temp dirs
	}
}
