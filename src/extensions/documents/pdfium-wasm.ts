/**
 * pdfium.wasm bytes resolution — mirrors pdfjs-assets.ts.
 *
 * The @hyzyla/pdfium loader resolves the .wasm next to its own JS at
 * runtime, which works in dev but not inside a compiled binary (bunfs
 * contains only what the bundler can see). Like the pdf.js assets, we stage
 * the WASM under share/kimchi/pdfium/ and read it ourselves, then hand the
 * bytes to PDFiumLibrary.init({ wasmBinary }) — one deterministic path for
 * dev, tests, and the packaged binary.
 */

import { existsSync, promises as fs } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveAuxiliaryFilesDir } from "../../auxiliary-files/resolver.js"

function tryPath(candidate: string): string | undefined {
	return existsSync(candidate) ? candidate : undefined
}

/** Where the pdfium WASM lives: packaged share dir, else node_modules (dev). */
export function resolvePdfiumWasmPath(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	execPath: string = process.execPath,
): string | undefined {
	// Candidate order: resolved aux-files dir, but also the binary's sibling
	// share dir directly — a parent kimchi session exports PI_PACKAGE_DIR at
	// its own install location, so the resolved dir can legitimately point
	// somewhere that does not ship the wasm (nested dev sessions hit this).
	const candidates: string[] = []
	const shareDir = resolveAuxiliaryFilesDir(env, home, execPath)
	if (execPath) candidates.push(join(execPath, "..", "..", "share", "kimchi", "pdfium", "pdfium.wasm"))
	candidates.push(join(shareDir, "pdfium", "pdfium.wasm"))
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate
	}
	try {
		const require = createRequire(import.meta.url)
		return tryPath(require.resolve("@hyzyla/pdfium/pdfium.wasm"))
	} catch {
		return undefined
	}
}

/** Read the wasm bytes once per process. Throws when nowhere to be found —
 *  callers (loadPdfium) convert that into a graceful degradation note. */
let cachedBytes: Uint8Array | undefined

export async function readPdfiumWasm(): Promise<Uint8Array> {
	if (cachedBytes) return cachedBytes
	const path = resolvePdfiumWasmPath()
	if (!path) {
		throw new Error("pdfium.wasm not found (packaged installs ship it under share/kimchi/pdfium/)")
	}
	cachedBytes = new Uint8Array(await fs.readFile(path))
	return cachedBytes
}

/** Test seam. */
export function __resetPdfiumWasmCacheForTests(): void {
	cachedBytes = undefined
}
