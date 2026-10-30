/**
 * `kimchi doc-cli <skill> <command> …` — the hidden in-binary route the
 * bundled document skills drive. The binary resolves the staged CLI bundle
 * itself and imports it in-process, so the agent never supplies a script
 * path: the permission gate only has to recognise the fixed command shape
 * (src/extensions/permissions/bundled-skill-cli.ts), and the `BUN_BE_BUN`
 * script-exec bootstrap (and its tempdir-EPERM failure class) is not
 * involved at all.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { resolveBundledSkillsDir } from "../../shared/skill-discovery/resolve-skill-roots.js"
import type { DocumentCliIo } from "./cli-utils.js"
import { DOC_CLI_SKILLS, type DocCliSkill } from "./doc-cli-skills.js"
import { isDocumentError } from "./model.js"

type CliRunner = (argv: string[], io: Pick<DocumentCliIo, "stdout" | "stderr">) => Promise<number>

export interface DocCliDeps {
	/** Bundled skills dir resolver; defaults to resolveBundledSkillsDir(). */
	bundledSkillsDir?: () => string | null
	/** Module loader; defaults to a dynamic import of the file URL. */
	importModule?: (url: string) => Promise<Record<string, unknown>>
	/** IO sink; defaults to console. */
	io?: Pick<DocumentCliIo, "stdout" | "stderr">
}

const USAGE = `usage: kimchi doc-cli <pdf|docx|xlsx|pptx> <command> [args...]

Runs a bundled document-skill CLI (pdf/docx/xlsx/pptx) inside the kimchi binary.`

function exportNameFor(skill: DocCliSkill): string {
	return `run${skill.charAt(0).toUpperCase()}${skill.slice(1)}Cli`
}

export async function runDocCliMain(args: string[], deps: DocCliDeps = {}): Promise<number> {
	const io =
		deps.io ??
		({
			stdout: (line: string) => console.log(line),
			stderr: (line: string) => console.error(line),
		} satisfies Pick<DocumentCliIo, "stdout" | "stderr">)
	const [skill, ...rest] = args
	if (!skill || !(DOC_CLI_SKILLS as readonly string[]).includes(skill)) {
		io.stderr(USAGE)
		return 2
	}
	const bundledDir = (deps.bundledSkillsDir ?? resolveBundledSkillsDir)()
	if (!bundledDir) {
		io.stderr("doc-cli: no bundled skills dir resolved (packaging bug)")
		return 2
	}
	const script = join(bundledDir, skill, "scripts", `${skill}.mjs`)
	if (!existsSync(script)) {
		io.stderr(`doc-cli: the ${skill} CLI is missing from this install (${script})`)
		return 2
	}
	const importModule =
		deps.importModule ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>)
	let mod: Record<string, unknown>
	try {
		mod = await importModule(pathToFileURL(script).href)
	} catch (err) {
		io.stderr(`doc-cli: failed to load the ${skill} CLI: ${String((err as Error)?.message ?? err)}`)
		return 2
	}
	const runner = mod[exportNameFor(skill as DocCliSkill)]
	if (typeof runner !== "function") {
		io.stderr(`doc-cli: the ${skill} CLI does not export ${exportNameFor(skill as DocCliSkill)} (packaging bug)`)
		return 2
	}
	try {
		return await (runner as CliRunner)(rest, io)
	} catch (err) {
		// Same contract as the standalone script boot (runCliScript): the
		// runners self-format DocumentError and return 2 internally; this
		// backstop only surfaces non-typed errors (still exit 2).
		if (!isDocumentError(err)) io.stderr(String((err as Error)?.message ?? err))
		return 2
	}
}
