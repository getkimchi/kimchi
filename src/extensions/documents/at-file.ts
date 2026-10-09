/**
 * @file rewriting for documents.
 *
 * Upstream pi inlines `@path` args by reading the file as UTF-8 — binary
 * documents come through as garbage. With the documents toggle on, cli.ts
 * rewrites each @document arg before upstream sees it: the extracted
 * Markdown (inline for ≤ 10 units, outline + read_document pointer above)
 * is written to a temp .md under the agent dir and the arg is swapped to
 * point at it. Toggle off: args pass through byte-identical.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { isDocumentPath } from "./detect.js"
import { AT_FILE_INLINE_MAX_UNITS } from "./limits.js"
import { isDocumentError } from "./model.js"
import { loadExtracted } from "./read-tool.js"
import { renderDocument, renderOutline } from "./render.js"

export interface AtFileRewriteOptions {
	cwd: string
	/** Where to write extracted markdown (agent dir tmp); injectable for tests. */
	tmpDir: string
	/** Env for limits overrides (KIMCHI_DOCUMENT_MAX_MB). */
	env?: NodeJS.ProcessEnv
	/** Whether an arg counts as @file — matches cli.ts's isCliAtFileArg. */
	isAtFileArg?: (arg: string, index: number, args: string[]) => boolean
}

export interface AtFileRewriteResult {
	args: string[]
	rewritten: Array<{ from: string; to: string; units: number; inlined: boolean }>
}

let counter = 0

export async function rewriteDocumentAtFileArgs(
	args: string[],
	options: AtFileRewriteOptions,
): Promise<AtFileRewriteResult> {
	const isAtFileArg = options.isAtFileArg ?? ((arg: string) => arg.startsWith("@") && arg.length > 1)
	const out: string[] = []
	const rewritten: AtFileRewriteResult["rewritten"] = []
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (!isAtFileArg(arg, i, args) || !isDocumentPath(arg.slice(1))) {
			out.push(arg)
			continue
		}
		const original = arg.slice(1)
		try {
			const { absolute, doc } = await loadExtracted(original, options.cwd, { env: options.env, tool: "at-file" })
			const inlined = doc.units.length <= AT_FILE_INLINE_MAX_UNITS
			const text = inlined ? renderDocument(doc, { path: absolute }).text : renderOutline(doc, absolute)
			await mkdir(options.tmpDir, { recursive: true })
			counter += 1
			const target = join(
				options.tmpDir,
				`atfile-${process.pid}-${Date.now().toString(36)}-${counter}-${basename(absolute).replace(/[^A-Za-z0-9._-]/g, "_")}.md`,
			)
			await writeFile(target, text, "utf-8")
			out.push(`@${target}`)
			rewritten.push({ from: absolute, to: target, units: doc.units.length, inlined })
		} catch (err) {
			if (isDocumentError(err)) {
				if (err.code === "not-a-document") {
					// Extension looked like a document but magic bytes disagree —
					// let upstream inline it as plain text.
					out.push(arg)
					continue
				}
				// Serious document errors (too large, corrupt): leave a marker file
				// so the model sees the typed error instead of UTF-8 garbage.
				await mkdir(options.tmpDir, { recursive: true })
				counter += 1
				const target = join(options.tmpDir, `atfile-${process.pid}-${counter}-error.md`)
				await writeFile(target, `Could not extract ${original}: ${err.message}\n`, "utf-8")
				out.push(`@${target}`)
				rewritten.push({ from: original, to: target, units: 0, inlined: false })
				continue
			}
			throw err
		}
	}
	return { args: out, rewritten }
}

/** Default tmp dir for at-file temp markdown: agent-scoped when the agent
 *  dir is known (consistent permissions/cleanup), os tmp otherwise. */
export function defaultAtFileTmpDir(agentDir?: string): string {
	return agentDir ? join(agentDir, "tmp", "atfile") : join(tmpdir(), "kimchi-atfile")
}
