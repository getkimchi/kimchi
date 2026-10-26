/** Shared CLI helpers for the four document skill scripts (docx/xlsx/pptx/pdf).
 *  Each bundled `.mjs` is a standalone script; they used to carry verbatim
 *  copies of these helpers. Message forms and exit codes match the old
 *  copies byte-for-byte — the skill consistency tests pin them. */

import { realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { maxFileBytes } from "./limits.js"
import { DocumentError, isDocumentError } from "./model.js"

/** Minimal io seam every document CLI exposes (pdf-cli extends it). */
export interface DocumentCliIo {
	stdout: (line: string) => void
	stderr: (line: string) => void
	readFile?: (path: string) => Uint8Array
	writeFile?: (path: string, data: Uint8Array) => void
}

/** Value of a `--name value` flag, or undefined when absent. */
export function flagValue(flags: string[], name: string): string | undefined {
	const i = flags.indexOf(name)
	return i >= 0 ? flags[i + 1] : undefined
}

/** readFile via the CLI io seam with a typed failure. */
export function readBytes(readFile: (path: string) => Uint8Array, path: string): Uint8Array {
	try {
		return readFile(path)
	} catch (err) {
		throw new DocumentError("corrupt", `Cannot read ${path}: ${(err as Error).message}`)
	}
}

/** Size-cap guard for inputs, uniform across the four skill CLIs. */
export function enforceSizeCap(path: string, data: Uint8Array): void {
	const cap = maxFileBytes()
	if (data.length > cap) {
		throw new DocumentError(
			"too-large",
			`${path} is ${(data.length / 1024 / 1024).toFixed(1)} MB, over the ${cap / 1024 / 1024} MB document cap. Raise it with KIMCHI_DOCUMENT_MAX_MB.`,
		)
	}
}

let atomicWriteCounter = 0

/** Atomic output: write to a temp sibling, then rename into place.
 *  pid + counter: two concurrent edits to the same --out path must not
 *  clobber each other's temp. Same-dir keeps renameSync on one filesystem.
 *  `marker` is the per-CLI temp suffix (e.g. "docx-mjs-tmp"). */
export function atomicWrite(path: string, data: Uint8Array, marker: string): void {
	const temp = `${path}.${marker}.${process.pid}.${++atomicWriteCounter}`
	try {
		writeFileSync(temp, data)
	} catch (err) {
		throw new DocumentError("corrupt", `Cannot write ${path}: ${(err as Error).message}`)
	}
	try {
		renameSync(temp, path)
	} catch (err) {
		try {
			unlinkSync(temp)
		} catch {
			// temp cleanup is best-effort; the OS reclaims temp files
		}
		throw new DocumentError("corrupt", `Cannot move output into place at ${path}: ${(err as Error).message}`)
	}
}

/** The CLI's writeFile seam resolved: the injected override when present,
 *  otherwise atomic temp+rename with this CLI's temp marker. */
export function defaultWriter(io: DocumentCliIo, marker: string): (path: string, data: Uint8Array) => void {
	return io.writeFile ?? ((path, data) => atomicWrite(path, data, marker))
}

/** True when this module is the directly executed script entry. */
export function isInvokedAsScript(metaUrl: string): boolean {
	const entry = process.argv[1]
	if (!entry) return false
	try {
		return realpathSync(entry) === fileURLToPath(metaUrl)
	} catch {
		return false
	}
}

/** Script boot: when invoked directly, run the CLI with console io and store
 *  the exit code. Typed errors print via the CLI's own formatting; anything
 *  else still exits nonzero instead of surfacing as an unhandled rejection. */
export function runCliScript<Io extends DocumentCliIo>(
	metaUrl: string,
	run: (argv: string[], io: Io) => Promise<number>,
): void {
	if (!isInvokedAsScript(metaUrl)) return
	run(process.argv.slice(2), {
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
	} as Io)
		.then((code) => {
			process.exitCode = code
		})
		.catch((err) => {
			if (!isDocumentError(err)) console.error(String((err as Error)?.message ?? err))
			process.exitCode = 2
		})
}
