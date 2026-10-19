/**
 * Doc-vs-CLI consistency: every command the skills' SKILL.md files advertise
 * must be a real command in the corresponding CLI, and every `--flag` they
 * show must appear in the CLI's usage text (the contract the model reads on
 * failure). Drift between SKILL.md prose and the CLI can't ship silently.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { runPdfCli } from "./pdf-cli.js"
import { runPptxCli } from "./pptx-cli.js"

const here = dirname(fileURLToPath(import.meta.url))
const skillDir = (name: string) => join(here, "..", "..", "..", "resources", "skills", name, "SKILL.md")

interface CommandSpec {
	skill: string
	cli: string
	run: (argv: string[], io: { stdout: (l: string) => void; stderr: (l: string) => void }) => Promise<number>
}

async function usageOf(spec: CommandSpec): Promise<string> {
	const out: string[] = []
	await spec.run([], { stdout: (line) => out.push(line), stderr: (line) => out.push(line) })
	return out.join("\n")
}

function extractCommands(markdown: string, cliName: string): string[] {
	const commands = new Set<string>()
	// `<cli>.mjs <command>` wherever it appears (headings, inline code, fences).
	const pattern = new RegExp(`${cliName}\\.mjs\\s+([a-z][a-z-]*)\\b`, "g")
	for (const m of markdown.matchAll(pattern)) commands.add(m[1]!)
	// Headings like `## read \`<file.pdf> [N-M]\`` — the verb right after ##.
	for (const m of markdown.matchAll(/^##+\s+(?:`)?([a-z][a-z-]*)(?:`|\s|<)/gm)) {
		const verb = m[1]!
		if (["usage", "error", "secure", "validation", "edit", "costs"].includes(verb)) continue
		commands.add(verb)
	}
	return [...commands].sort()
}

/** Flags shown in command examples: lines invoking the CLI, or `##` command
 *  headings. Prose mentioning other tools' flags (e.g. `brew --cask`) is out. */
function extractFlags(markdown: string, cliName: string): string[] {
	const flags = new Set<string>()
	for (const line of markdown.split(/\r?\n/)) {
		const isCommandLine = line.includes(`${cliName}.mjs`)
		const isCommandHeading = /^##\s/.test(line)
		if (!isCommandLine && !isCommandHeading) continue
		for (const m of line.matchAll(/(?<![\w-])(--[a-z][a-z-]+)\b/g)) flags.add(m[1]!)
	}
	return [...flags].sort()
}

describe("skill SKILL.md ↔ CLI contract", () => {
	const specs: CommandSpec[] = [
		{
			skill: "pptx",
			cli: "pptx",
			run: (argv, io) => runPptxCli(argv, io),
		},
		{
			skill: "pdf",
			cli: "pdf",
			run: (argv, io) => runPdfCli(argv, io),
		},
	]

	for (const spec of specs) {
		it(`${spec.skill}: every SKILL.md command is a real CLI command`, async () => {
			const markdown = readFileSync(skillDir(spec.skill), "utf-8")
			const usage = await usageOf(spec)
			for (const command of extractCommands(markdown, spec.cli)) {
				expect(usage, `SKILL.md advertises "${command}" but ${spec.cli}.mjs usage does not list it`).toContain(command)
				expect(command.length).toBeGreaterThan(1)
			}
		})

		it(`${spec.skill}: every --flag in SKILL.md appears in usage`, async () => {
			const markdown = readFileSync(skillDir(spec.skill), "utf-8")
			const usage = await usageOf(spec)
			for (const flag of extractFlags(markdown, spec.cli)) {
				expect(usage, `SKILL.md shows ${flag} but ${spec.cli}.mjs usage does not`).toContain(flag)
			}
		})

		it(`${spec.skill}: SKILL.md names the exit-2 size cap env var the CLI honors`, () => {
			const markdown = readFileSync(skillDir(spec.skill), "utf-8")
			expect(markdown).toContain("KIMCHI_DOCUMENT_MAX_MB")
		})
	}
})
