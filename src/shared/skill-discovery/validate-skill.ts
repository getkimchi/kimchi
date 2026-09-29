import { readFileSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

/** Validate the creator's required frontmatter without loading or executing the skill. */
export function validateSkill(filePath: string): void {
	const content = readFileSync(filePath, "utf8")
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
	const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content)
	if (!match) throw new Error("Expected YAML frontmatter between --- lines at the start of SKILL.md")
	const metadata = parse(match[1])
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		throw new Error("Frontmatter must be a YAML mapping")
	}
	const { name, description } = metadata
	if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
		throw new Error("name must be 1–64 lowercase letters, digits, or single hyphens between words")
	}
	if (name !== basename(dirname(filePath))) throw new Error("name must match the skill folder name")
	if (typeof description !== "string" || !description.trim() || description.length > 1024) {
		throw new Error("description must be a nonempty string of at most 1024 characters")
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2)
	if (args.length !== 1) {
		console.error("Usage: node validate-skill.mjs <skill-folder-or-SKILL.md>")
		process.exitCode = 1
	} else {
		const target = resolve(args[0])
		const filePath = basename(target) === "SKILL.md" ? target : join(target, "SKILL.md")
		try {
			validateSkill(filePath)
			console.log(`Valid frontmatter: ${filePath}`)
		} catch (error) {
			console.error(`${filePath}: ${error instanceof Error ? error.message : String(error)}`)
			process.exitCode = 1
		}
	}
}
