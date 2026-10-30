import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runDocCliMain } from "./doc-cli-main.js"
import { DOC_CLI_SKILLS, type DocCliSkill } from "./doc-cli-skills.js"
import { DocumentError } from "./model.js"

/** A fake bundled dir containing an (empty) script for every skill. */
function fakeBundledDir(root: string): string {
	for (const skill of DOC_CLI_SKILLS) {
		const dir = join(root, skill, "scripts")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, `${skill}.mjs`), "// stub\n")
	}
	return root
}

function exportNameFor(skill: DocCliSkill): string {
	return `run${skill.charAt(0).toUpperCase()}${skill.slice(1)}Cli`
}

interface Io {
	stdout: (line: string) => void
	stderr: (line: string) => void
}

describe("runDocCliMain", () => {
	let root: string
	let out: string[]
	let err: string[]

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "kimchi-doc-cli-test-"))
		out = []
		err = []
	})
	afterEach(() => {
		rmSync(root, { recursive: true, force: true })
	})

	const io = (): Io => ({
		stdout: (line) => out.push(line),
		stderr: (line) => err.push(line),
	})

	it("dispatches to each skill's exported runner with the remaining args", async () => {
		for (const skill of DOC_CLI_SKILLS) {
			out = []
			err = []
			const calls: { argv: string[] }[] = []
			const code = await runDocCliMain([skill, "read", "x.pdf", "1-2"], {
				bundledSkillsDir: () => fakeBundledDir(join(root, skill)),
				importModule: async (url) => {
					// The URL the harness built points at the skill's staged script.
					expect(fileURLToPath(url)).toBe(join(root, skill, skill, "scripts", `${skill}.mjs`))
					return {
						[exportNameFor(skill)]: async (argv: string[], io: Io) => {
							calls.push({ argv })
							io.stdout(`${skill}-ok`)
							return 7
						},
					}
				},
				io: io(),
			})
			expect(code).toBe(7)
			expect(calls).toEqual([{ argv: ["read", "x.pdf", "1-2"] }])
			expect(out).toEqual([`${skill}-ok`])
		}
	})

	it("rejects an unknown skill with usage before any filesystem access", async () => {
		let imports = 0
		const code = await runDocCliMain(["evil", "read", "x.pdf"], {
			bundledSkillsDir: () => fakeBundledDir(root),
			importModule: async () => {
				imports++
				return {}
			},
			io: io(),
		})
		expect(code).toBe(2)
		expect(imports).toBe(0)
		expect(err.join("\n")).toContain("usage: kimchi doc-cli")
	})

	it("rejects path-traversal-shaped skill args as unknown skills", async () => {
		const code = await runDocCliMain(["../pdf", "read"], {
			bundledSkillsDir: () => fakeBundledDir(root),
			importModule: async () => {
				throw new Error("must not be called")
			},
			io: io(),
		})
		expect(code).toBe(2)
		expect(err.join("\n")).toContain("usage: kimchi doc-cli")
	})

	it("prints usage when called with no arguments", async () => {
		const code = await runDocCliMain([], { bundledSkillsDir: () => root, importModule: async () => ({}), io: io() })
		expect(code).toBe(2)
		expect(err.join("\n")).toContain("usage: kimchi doc-cli")
	})

	it("fails cleanly when no bundled skills dir resolves", async () => {
		const code = await runDocCliMain(["pdf", "info", "x.pdf"], {
			bundledSkillsDir: () => null,
			importModule: async () => {
				throw new Error("must not be called")
			},
			io: io(),
		})
		expect(code).toBe(2)
		expect(err.join("\n")).toContain("no bundled skills dir")
	})

	it("fails cleanly when the skill's script is missing from the install", async () => {
		const empty = join(root, "empty")
		mkdirSync(empty)
		const code = await runDocCliMain(["pdf", "info", "x.pdf"], {
			bundledSkillsDir: () => empty,
			importModule: async () => {
				throw new Error("must not be called")
			},
			io: io(),
		})
		expect(code).toBe(2)
		expect(err.join("\n")).toContain("missing from this install")
	})

	it("fails cleanly when the module cannot be imported", async () => {
		const code = await runDocCliMain(["pdf", "info", "x.pdf"], {
			bundledSkillsDir: () => fakeBundledDir(root),
			importModule: async () => {
				throw new Error("boom")
			},
			io: io(),
		})
		expect(code).toBe(2)
		expect(err.join("\n")).toContain("failed to load the pdf CLI: boom")
	})

	it("fails cleanly when the module does not export the runner", async () => {
		const code = await runDocCliMain(["pdf", "info", "x.pdf"], {
			bundledSkillsDir: () => fakeBundledDir(root),
			importModule: async () => ({ somethingElse: true }),
			io: io(),
		})
		expect(code).toBe(2)
		expect(err.join("\n")).toContain("does not export runPdfCli")
	})

	it("swallows a DocumentError thrown by the runner (the runner self-formats)", async () => {
		// runCliScript contract: the real runners format DocumentError
		// internally and return 2 — the backstop prints nothing for typed
		// errors so the message is never duplicated.
		const code = await runDocCliMain(["pdf", "read", "nope.pdf"], {
			bundledSkillsDir: () => fakeBundledDir(root),
			importModule: async () => ({
				runPdfCli: async () => {
					throw new DocumentError("corrupt", "cannot read nope.pdf", "pdf")
				},
			}),
			io: io(),
		})
		expect(code).toBe(2)
		expect(err).toEqual([])
	})

	it("prints and fails on a non-typed error thrown by the runner", async () => {
		const code = await runDocCliMain(["docx", "read", "x.docx"], {
			bundledSkillsDir: () => fakeBundledDir(root),
			importModule: async () => ({
				runDocxCli: async () => {
					throw new Error("unexpected")
				},
			}),
			io: io(),
		})
		expect(code).toBe(2)
		expect(err).toEqual(["unexpected"])
	})
})
