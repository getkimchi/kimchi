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

// Bundle the pdf skill's CLI. Same staging-deref recipe as pptx:
// unpdf/@cantoo/pdf-lib are dependency graphs pnpm nests, so stage the whole
// package trees and let bun trace them. Fonts are discovered on the host at
// runtime (pdf-fonts.ts scans the OS font dirs).
const pdfSkillsDest = join(projectRoot, isDev ? "resources" : "dist/share/kimchi", "skills/pdf")
{
	const pdfCliDest = join(pdfSkillsDest, "scripts", "pdf.mjs")
	mkdirSync(dirname(pdfCliDest), { recursive: true })
	const pdfStaging = mkdtempSync(join(tmpdir(), "kimchi-pdf-build-"))
	try {
		const stagedEntry = join(pdfStaging, "pdf-cli.ts")
		cpSync(join(projectRoot, "src", "extensions", "documents", "pdf-cli.ts"), stagedEntry)
		cpSync(join(projectRoot, "src", "extensions", "documents"), join(pdfStaging, "documents"), {
			recursive: true,
			filter: (src) => !src.endsWith(".test.ts"),
		})
		let entry = readFileSync(stagedEntry, "utf-8")
		entry = entry.replaceAll('from "./', 'from "./documents/')
		writeFileSync(stagedEntry, entry)
		// Stage each runtime dep AND its transitive tree (pnpm nests them).
		// Packages land flat into the staging node_modules; children resolve via
		// a require anchored at their parent's real manifest (pnpm layout).
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
			cpSync(dirname(realPkg), join(pdfStaging, "node_modules", name), { dereference: true, recursive: true })
			const manifest = JSON.parse(readFileSync(realPkg, "utf-8"))
			for (const child of Object.keys(manifest.dependencies ?? {})) {
				try {
					stageDep(child, realPkg)
				} catch {
					// optional dep not installed — bundling fails loudly if it's truly needed
				}
			}
		}
		for (const dep of ["@cantoo/pdf-lib", "@pdf-lib/fontkit", "unpdf", "marked", "@hyzyla/pdfium"]) {
			stageDep(dep)
		}
		const stagedOut = join(pdfStaging, "pdf.mjs")
		execFileSync("bun", ["build", stagedEntry, "--target=node", "--format=esm", "--outfile", stagedOut], {
			stdio: "inherit",
		})
		cpSync(stagedOut, pdfCliDest)
		// The LO-edit macro ships beside the CLI: the CLI stages it into a
		// throwaway LibreOffice profile at run time. In dev mode the skill dir
		// IS the source dir, so the copy would be src === dest — skip it.
		const lodrawSrc = join(projectRoot, "resources", "skills", "pdf", "scripts", "lodraw_edit.py")
		const lodrawDest = join(dirname(pdfCliDest), "lodraw_edit.py")
		if (resolve(lodrawSrc) !== resolve(lodrawDest)) {
			cpSync(lodrawSrc, lodrawDest)
		}
		// Same-self-copy guard for the bundled PDFium WASM used by render's
		// in-process core route.
		{
			const requireFrom = createRequire(join(projectRoot, "package.json"))
			const wasmSrc = realpathSync(requireFrom.resolve("@hyzyla/pdfium/pdfium.wasm"))
			const wasmDest = join(dirname(pdfCliDest), "pdfium.wasm")
			if (resolve(wasmSrc) !== resolve(wasmDest)) {
				cpSync(wasmSrc, wasmDest)
			}
		}
	} finally {
		try {
			rmSync(pdfStaging, { recursive: true, force: true })
		} catch {
			// ignore — the OS reclaims temp dirs
		}
	}
}

// Bundle the docx skill's CLI. Same staging-deref recipe as pdf: stage the
// documents module tree plus the `docx` dependency graph (jszip, nanoid,
// hash.js). jszip's CJS entry pulls transitive deps we don't stage; its
// dist/jszip.min.js is self-contained, so point the staged package at it.
{
	const docxCliDest = join(projectRoot, isDev ? "resources" : "dist/share/kimchi", "skills/docx/scripts/docx.mjs")
	mkdirSync(dirname(docxCliDest), { recursive: true })
	const docxStaging = mkdtempSync(join(tmpdir(), "kimchi-docx-build-"))
	try {
		const stagedEntry = join(docxStaging, "docx-cli.ts")
		cpSync(join(projectRoot, "src", "extensions", "documents", "docx-cli.ts"), stagedEntry)
		cpSync(join(projectRoot, "src", "extensions", "documents"), join(docxStaging, "documents"), {
			recursive: true,
			filter: (src) => !src.endsWith(".test.ts"),
		})
		let entry = readFileSync(stagedEntry, "utf-8")
		entry = entry.replaceAll('from "./', 'from "./documents/')
		writeFileSync(stagedEntry, entry)
		const stagedPkgs = new Set()
		const stageDep = (name, anchor) => {
			if (stagedPkgs.has(name)) return
			stagedPkgs.add(name)
			const requireFrom = createRequire(anchor ?? join(projectRoot, "package.json"))
			let realPkg
			try {
				realPkg = realpathSync(requireFrom.resolve(`${name}/package.json`))
			} catch {
				let dir = dirname(realpathSync(requireFrom.resolve(name)))
				while (!existsSync(join(dir, "package.json"))) {
					const up = dirname(dir)
					if (up === dir) throw new Error(`no package.json above ${name}`)
					dir = up
				}
				realPkg = join(dir, "package.json")
			}
			cpSync(dirname(realPkg), join(docxStaging, "node_modules", name), { dereference: true, recursive: true })
			const manifest = JSON.parse(readFileSync(realPkg, "utf-8"))
			for (const child of Object.keys(manifest.dependencies ?? {})) {
				try {
					stageDep(child, realPkg)
				} catch {
					// optional dep not installed — bundling fails loudly if it's truly needed
				}
			}
		}
		for (const dep of ["docx", "@xmldom/xmldom", "jszip", "marked", "yauzl"]) {
			stageDep(dep)
		}
		// jszip's package root resolves lib/index.js (-> lie, pako, …, not staged).
		// Its dist/jszip.min.js is self-contained; point the manifest at it.
		{
			const jszipPkgPath = join(docxStaging, "node_modules", "jszip", "package.json")
			const jszipPkg = JSON.parse(readFileSync(jszipPkgPath, "utf-8"))
			jszipPkg.main = "dist/jszip.min.js"
			writeFileSync(jszipPkgPath, JSON.stringify(jszipPkg))
		}
		const stagedOut = join(docxStaging, "docx.mjs")
		execFileSync("bun", ["build", stagedEntry, "--target=node", "--format=esm", "--outfile", stagedOut], {
			stdio: "inherit",
		})
		cpSync(stagedOut, docxCliDest)
	} finally {
		try {
			rmSync(docxStaging, { recursive: true, force: true })
		} catch {
			// ignore — the OS reclaims temp dirs
		}
	}
}

// Bundle the xlsx skill's CLI. Same recipe as docx: stage the documents
// module tree plus the jszip/@xmldom/yauzl graph the extractor/editor needs.
{
	const xlsxCliDest = join(projectRoot, isDev ? "resources" : "dist/share/kimchi", "skills/xlsx/scripts/xlsx.mjs")
	mkdirSync(dirname(xlsxCliDest), { recursive: true })
	const xlsxStaging = mkdtempSync(join(tmpdir(), "kimchi-xlsx-build-"))
	try {
		const stagedEntry = join(xlsxStaging, "xlsx-cli.ts")
		cpSync(join(projectRoot, "src", "extensions", "documents", "xlsx-cli.ts"), stagedEntry)
		cpSync(join(projectRoot, "src", "extensions", "documents"), join(xlsxStaging, "documents"), {
			recursive: true,
			filter: (src) => !src.endsWith(".test.ts"),
		})
		let entry = readFileSync(stagedEntry, "utf-8")
		entry = entry.replaceAll('from "./', 'from "./documents/')
		writeFileSync(stagedEntry, entry)
		{
			// yauzl's transitive deps (fd-slicer, pend, buffer-crc32) aren't
			// hoisted by pnpm — walk the dependency graph like the docx block.
			const stagedPkgs = new Set()
			const stageDep = (name, anchor) => {
				if (stagedPkgs.has(name)) return
				stagedPkgs.add(name)
				const requireFrom = createRequire(anchor ?? join(projectRoot, "package.json"))
				let realPkg
				try {
					realPkg = realpathSync(requireFrom.resolve(`${name}/package.json`))
				} catch {
					let dir = dirname(realpathSync(requireFrom.resolve(name)))
					while (!existsSync(join(dir, "package.json"))) {
						const up = dirname(dir)
						if (up === dir) throw new Error(`no package.json above ${name}`)
						dir = up
					}
					realPkg = join(dir, "package.json")
				}
				cpSync(dirname(realPkg), join(xlsxStaging, "node_modules", name), { dereference: true, recursive: true })
				const manifest = JSON.parse(readFileSync(realPkg, "utf-8"))
				for (const child of Object.keys(manifest.dependencies ?? {})) {
					try {
						stageDep(child, realPkg)
					} catch {
						// optional dep not installed — bundling fails loudly if it's truly needed
					}
				}
			}
			for (const dep of ["@xmldom/xmldom", "jszip", "yauzl"]) {
				stageDep(dep)
			}
		}
		const jszipPkgPath = join(xlsxStaging, "node_modules", "jszip", "package.json")
		const jszipPkg = JSON.parse(readFileSync(jszipPkgPath, "utf-8"))
		jszipPkg.main = "dist/jszip.min.js"
		writeFileSync(jszipPkgPath, JSON.stringify(jszipPkg))
		const stagedOut = join(xlsxStaging, "xlsx.mjs")
		execFileSync("bun", ["build", stagedEntry, "--target=node", "--format=esm", "--outfile", stagedOut], {
			stdio: "inherit",
		})
		cpSync(stagedOut, xlsxCliDest)
	} finally {
		try {
			rmSync(xlsxStaging, { recursive: true, force: true })
		} catch {
			// ignore — the OS reclaims temp dirs
		}
	}
}

// Bundle the pptx skill's CLI (same staging-deref dance as validate-skill:
// bun resolves jszip/@xmldom from the staged node_modules, not the repo).
const pptxCliDest = join(projectRoot, isDev ? "resources" : "dist/share/kimchi", "skills/pptx/scripts/pptx.mjs")
mkdirSync(dirname(pptxCliDest), { recursive: true })
const pptxStaging = mkdtempSync(join(tmpdir(), "kimchi-pptx-build-"))
try {
	const stagedEntry = join(pptxStaging, "pptx-cli.ts")
	cpSync(join(projectRoot, "src", "extensions", "documents", "pptx-cli.ts"), stagedEntry)
	// The entry imports its siblings — stage the whole documents module tree.
	cpSync(join(projectRoot, "src", "extensions", "documents"), join(pptxStaging, "documents"), {
		recursive: true,
		filter: (src) => !src.endsWith(".test.ts"),
	})
	// Rewrite the entry's relative imports to the staged tree.
	let entry = readFileSync(stagedEntry, "utf-8")
	entry = entry.replaceAll('from "./', 'from "./documents/')
	writeFileSync(stagedEntry, entry)
	// jszip's CJS entry pulls transitive deps (lie, pako, …) we don't stage;
	// its dist/jszip.min.js is self-contained, so point the staged package at it.
	const jszipDest = join(pptxStaging, "node_modules", "jszip")
	cpSync(join(projectRoot, "node_modules", "jszip"), jszipDest, { dereference: true, recursive: true })
	const jszipPkg = JSON.parse(readFileSync(join(jszipDest, "package.json"), "utf-8"))
	jszipPkg.main = "dist/jszip.min.js"
	writeFileSync(join(jszipDest, "package.json"), JSON.stringify(jszipPkg))
	// @xmldom/xmldom and image-size are dependency-free; pptxgenjs depends
	// only on the already-staged jszip/image-size. image-size isn't hoisted
	// to node_modules root (pnpm nests it under pptxgenjs), so resolve it
	// through pptxgenjs's own package context.
	for (const dep of ["@xmldom/xmldom", "pptxgenjs", "marked", "yauzl"]) {
		cpSync(join(projectRoot, "node_modules", dep), join(pptxStaging, "node_modules", dep), {
			dereference: true,
			recursive: true,
		})
	}
	// Walk through pnpm's symlink: deps live next to pptxgenjs's real path.
	const pptxgenjsPkg = realpathSync(join(projectRoot, "node_modules", "pptxgenjs", "package.json"))
	const pptxgenjsRequire = createRequire(pptxgenjsPkg)
	const imageSizePath = dirname(dirname(pptxgenjsRequire.resolve("image-size/package.json")))
	cpSync(imageSizePath, join(pptxStaging, "node_modules", "image-size"), { dereference: true, recursive: true })
	// yauzl's one dep lives under yauzl's own pnpm context, same pattern.
	const yauzlRequire = createRequire(realpathSync(join(projectRoot, "node_modules", "yauzl", "package.json")))
	const pendPath = dirname(yauzlRequire.resolve("pend/package.json"))
	cpSync(pendPath, join(pptxStaging, "node_modules", "pend"), { dereference: true, recursive: true })
	const stagedOut = join(pptxStaging, "pptx.mjs")
	execFileSync("bun", ["build", stagedEntry, "--target=node", "--format=esm", "--outfile", stagedOut], {
		stdio: "inherit",
	})
	cpSync(stagedOut, pptxCliDest)
} finally {
	try {
		rmSync(pptxStaging, { recursive: true, force: true })
	} catch {
		// ignore — the OS reclaims temp dirs
	}
}

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
