import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import type { Dirent } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { z } from "zod"

export const CLAUDE_CODE_SKILLS_RESOURCE_ID = "extensions.claude-code-skills"

interface ClaudeCodeSkillResourceOptions {
	excludeSkillNames?: Iterable<string>
}

const SkillFrontmatterSchema = z
	.object({
		name: z.string().optional(),
		description: z.string().optional(),
	})
	.catchall(z.unknown())

type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

let claudeCodeSkillsCacheDir: string | undefined

export function discoverClaudeCodeSkillDirs(cwd = process.cwd()): string[] {
	const projectDir = resolve(cwd)
	if (!existsSync(join(projectDir, ".claude"))) return []

	const homeDir = homedir()
	const dirs = [join(homeDir, ".claude", "skills")]
	if (resolve(projectDir) !== resolve(homeDir)) {
		dirs.push(join(projectDir, ".claude", "skills"))
	}

	const seen = new Set<string>()
	const result: string[] = []
	for (const dir of dirs) {
		if (seen.has(dir) || !existsSync(dir)) continue
		seen.add(dir)
		result.push(dir)
	}
	return result
}

export function getClaudeCodeSkillResourcePaths(
	cwd = process.cwd(),
	options: ClaudeCodeSkillResourceOptions = {},
): string[] {
	const excludedSkillNames = new Set(options.excludeSkillNames ?? [])
	const paths: string[] = []
	for (const dir of discoverClaudeCodeSkillDirs(cwd)) {
		paths.push(...materializeClaudeCodeSkillDir(dir, { excludeSkillNames: excludedSkillNames }))
	}
	return paths
}

export function getConfiguredSkillResourcePaths(cwd: string, configuredSkillPaths: string[]): string[] {
	const expandedPaths = expandConfiguredSkillPaths(configuredSkillPaths, cwd)
	const nativeSkillNames = collectNativeSkillNames(expandedPaths)
	return expandedPaths.flatMap((path) =>
		isClaudeCodeSkillPath(path)
			? materializeClaudeCodeSkillPath(path, { excludeSkillNames: nativeSkillNames })
			: [path],
	)
}

export function getConfiguredNativeSkillNames(cwd: string, configuredSkillPaths: string[]): string[] {
	return [...collectNativeSkillNames(expandConfiguredSkillPaths(configuredSkillPaths, cwd))]
}

export function sanitizeSkillMarkdown(content: string, fallbackName: string): string {
	const markdown = extractSkillMarkdown(content)
	if (markdown === undefined) {
		const name = normalizeSkillName(fallbackName)
		return ["---", stringifyFallbackSkillFrontmatter(name), "---", content].join("\n")
	}

	return ["---", sanitizeFrontmatter(markdown.frontmatter, fallbackName), "---", markdown.body.replace(/^\n/, "")].join(
		"\n",
	)
}

function getClaudeCodeSkillsCacheDir(): string {
	if (claudeCodeSkillsCacheDir === undefined) {
		claudeCodeSkillsCacheDir = mkdtempSync(join(tmpdir(), "kimchi-claude-code-skills-"))
		process.once("exit", () => {
			if (claudeCodeSkillsCacheDir) rmSync(claudeCodeSkillsCacheDir, { recursive: true, force: true })
		})
	}
	return claudeCodeSkillsCacheDir
}

function walkSkillDirs(dir: string): string[] {
	const results: string[] = []
	walkSkillDirsInto(dir, results)
	return results
}

function materializeClaudeCodeSkillPath(
	path: string,
	options: Pick<ClaudeCodeSkillResourceOptions, "excludeSkillNames"> = {},
): string[] {
	if (extname(path) === ".md") {
		const fallbackName = basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md")
		const excludedSkillNames = new Set(options.excludeSkillNames ?? [])
		if (excludedSkillNames.has(readSkillNameFromFile(path, fallbackName))) return []

		const cacheSkillPath = join(getClaudeCodeSkillsCacheDir(), hash(path), slugPath(fallbackName))
		try {
			return [copyAndSanitizeSkillFile(path, cacheSkillPath, fallbackName)]
		} catch {
			return []
		}
	}
	return materializeClaudeCodeSkillDir(path, options)
}

function materializeClaudeCodeSkillDir(
	skillsDir: string,
	options: Pick<ClaudeCodeSkillResourceOptions, "excludeSkillNames"> = {},
): string[] {
	const excludedSkillNames = new Set(options.excludeSkillNames ?? [])
	const paths: string[] = []
	for (const skillDir of walkSkillDirs(skillsDir)) {
		if (excludedSkillNames.has(readSkillName(skillDir))) continue
		const relativeSkillPath = relative(skillsDir, skillDir)
		const cacheSkillPath = join(
			getClaudeCodeSkillsCacheDir(),
			hash(skillsDir),
			slugPath(relativeSkillPath || basename(skillDir)),
		)
		try {
			paths.push(copyAndSanitizeSkillDir(skillDir, cacheSkillPath))
		} catch {}
	}
	return paths
}

function expandConfiguredSkillPaths(paths: string[], cwd: string): string[] {
	const home = resolve(homedir())
	const projectDir = resolve(cwd)
	const expanded: string[] = []
	for (const path of paths) {
		if (isAbsolute(path)) {
			expanded.push(normalize(path))
		} else if (path.startsWith("~/")) {
			expanded.push(resolve(home, path.slice(2)))
		} else {
			const fromHome = resolve(home, path)
			const fromCwd = resolve(projectDir, path)
			if (isSameOrDescendant(fromHome, home)) expanded.push(fromHome)
			if (isSameOrDescendant(fromCwd, projectDir)) expanded.push(fromCwd)
		}
	}
	return expanded
}

function isSameOrDescendant(path: string, parent: string): boolean {
	const relativePath = relative(parent, path)
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

function isClaudeCodeSkillPath(path: string): boolean {
	return path.split(/[\\/]+/).includes(".claude")
}

function collectNativeSkillNames(paths: string[]): Set<string> {
	const names = new Set<string>()
	for (const path of paths) {
		if (isClaudeCodeSkillPath(path)) continue
		if (extname(path) === ".md") {
			if (!existsSync(path)) continue
			const fallbackName = basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md")
			names.add(readSkillNameFromFile(path, fallbackName))
			continue
		}
		for (const skillDir of walkSkillDirs(path)) {
			names.add(readSkillName(skillDir))
		}
	}
	return names
}

function walkSkillDirsInto(dir: string, results: string[]): void {
	let entries: Dirent[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return
	}

	if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
		results.push(dir)
		return
	}

	for (const entry of entries) {
		if (entry.isDirectory() && !entry.name.startsWith(".")) {
			walkSkillDirsInto(join(dir, entry.name), results)
		}
	}
}

function copyAndSanitizeSkillDir(skillDir: string, cacheSkillPath: string): string {
	rmSync(cacheSkillPath, { recursive: true, force: true })
	mkdirSync(cacheSkillPath, { recursive: true })
	cpSync(skillDir, cacheSkillPath, { recursive: true, force: true })

	const skillFilePath = join(cacheSkillPath, "SKILL.md")
	if (existsSync(skillFilePath)) {
		writeFileSync(
			skillFilePath,
			sanitizeSkillMarkdown(readFileSync(skillFilePath, "utf-8"), basename(skillDir)),
			"utf-8",
		)
	}

	return cacheSkillPath
}

function copyAndSanitizeSkillFile(skillFilePath: string, cacheSkillPath: string, fallbackName: string): string {
	rmSync(cacheSkillPath, { recursive: true, force: true })
	mkdirSync(cacheSkillPath, { recursive: true })
	writeFileSync(
		join(cacheSkillPath, "SKILL.md"),
		sanitizeSkillMarkdown(readFileSync(skillFilePath, "utf-8"), fallbackName),
		"utf-8",
	)
	return cacheSkillPath
}

function extractSkillMarkdown(content: string): { frontmatter: string; body: string } | undefined {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
	if (!normalized.startsWith("---\n")) return undefined

	const end = normalized.indexOf("\n---\n", 4)
	if (end === -1) return undefined

	return {
		frontmatter: normalized.slice(4, end),
		body: normalized.slice(end + "\n---\n".length),
	}
}

function sanitizeFrontmatter(frontmatter: string, fallbackName: string): string {
	const parsed = parseSkillFrontmatter(frontmatter)
	if (parsed) return stringifySkillFrontmatter(parsed, fallbackName)
	return sanitizeLooseFrontmatter(frontmatter, fallbackName)
}

function stringifyFallbackSkillFrontmatter(name: string): string {
	return stringifyYaml({ name, description: fallbackSkillDescription(name) }).trimEnd()
}

function fallbackSkillDescription(name: string): string {
	return `Claude Code skill: ${name}.`
}

function parseSkillFrontmatter(frontmatter: string): SkillFrontmatter | undefined {
	try {
		const parsed = SkillFrontmatterSchema.safeParse(parseYaml(frontmatter) ?? {})
		return parsed.success ? parsed.data : undefined
	} catch {
		return undefined
	}
}

function stringifySkillFrontmatter(frontmatter: SkillFrontmatter, fallbackName: string): string {
	const name = normalizeSkillName(frontmatter.name ?? fallbackName, fallbackName)
	const description = frontmatter.description?.trim()
	const sanitized: Record<string, unknown> = {
		name,
		description: description || fallbackSkillDescription(name),
	}
	for (const [key, value] of Object.entries(frontmatter)) {
		if (key === "name" || key === "description" || isToolsFrontmatterKey(key)) continue
		sanitized[key] = value
	}
	return stringifyYaml(sanitized).trimEnd()
}

function sanitizeLooseFrontmatter(frontmatter: string, fallbackName: string): string {
	const lines = frontmatter.split("\n")
	const name = findLooseFrontmatterName(lines, fallbackName)
	const sanitized: string[] = []
	let hasName = false
	let hasDescription = false

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]
		const keyValue = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
		if (keyValue === null) {
			sanitized.push(line)
			continue
		}

		const key = keyValue[1]
		const value = keyValue[2].trim()

		if (isToolsFrontmatterKey(key)) {
			index = skipNestedYamlValue(lines, index, 0)
			continue
		}

		if (key === "name") {
			hasName = true
			sanitized.push(`name: ${quoteYamlString(name)}`)
			continue
		}

		if (key === "description") {
			hasDescription = true
			const description = stripOuterQuotes(value)
			if (value === "" || description.trim() === "") {
				sanitized.push(`description: ${quoteYamlString(fallbackSkillDescription(name))}`)
				continue
			}
			if (isBlockScalar(value)) {
				const end = skipNestedYamlValue(lines, index, 0)
				const blockLines = lines.slice(index + 1, end + 1)
				if (blockLines.some((line) => line.trim() !== "")) {
					sanitized.push(line, ...blockLines)
				} else {
					sanitized.push(`description: ${quoteYamlString(fallbackSkillDescription(name))}`)
				}
				index = end
				continue
			}
			sanitized.push(`${key}: ${formatLooseYamlScalar(value)}`)
			continue
		}

		if (value === "" || isBlockScalar(value)) {
			sanitized.push(line)
			continue
		}

		sanitized.push(`${key}: ${formatLooseYamlScalar(value)}`)
	}

	if (!hasName) {
		sanitized.unshift(`name: ${quoteYamlString(name)}`)
	}

	if (!hasDescription) {
		const descriptionLine = `description: ${quoteYamlString(fallbackSkillDescription(name))}`
		const nameIndex = sanitized.findIndex((line) => line.startsWith("name:"))
		if (nameIndex === -1) {
			sanitized.unshift(descriptionLine)
		} else {
			sanitized.splice(nameIndex + 1, 0, descriptionLine)
		}
	}

	return sanitized.join("\n")
}

function findLooseFrontmatterName(lines: string[], fallbackName: string): string {
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]
		const keyValue = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
		if (keyValue === null) continue

		const key = keyValue[1]
		if (isToolsFrontmatterKey(key)) {
			index = skipNestedYamlValue(lines, index, 0)
			continue
		}
		if (key === "name") return normalizeSkillName(stripOuterQuotes(keyValue[2].trim()), fallbackName)
	}
	return normalizeSkillName(fallbackName)
}

function skipNestedYamlValue(lines: string[], index: number, parentIndent: number): number {
	for (let next = index + 1; next < lines.length; next++) {
		const line = lines[next]
		if (line.trim() === "") continue
		if (countIndent(line) <= parentIndent) return next - 1
	}
	return lines.length - 1
}

function countIndent(line: string): number {
	return line.match(/^ */)?.[0].length ?? 0
}

function isToolsFrontmatterKey(key: string): boolean {
	return ["tools", "allowed-tools", "allowed_tools", "allowedTools"].includes(key)
}

function formatLooseYamlScalar(value: string): string {
	if (isQuotedString(value)) return value
	const unquoted = stripOuterQuotes(value)
	if (/^(true|false|null)$/i.test(unquoted) || /^-?\d+(\.\d+)?$/.test(unquoted)) return unquoted
	return quoteYamlString(unquoted)
}

function normalizeSkillName(name: string, fallbackName = "skill"): string {
	const normalized = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")

	if (normalized) return normalized
	return normalizeSkillName(fallbackName, "skill")
}

function stripOuterQuotes(value: string): string {
	if (isQuotedString(value)) {
		return value.slice(1, -1)
	}
	return value
}

function isQuotedString(value: string): boolean {
	return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
}

function quoteYamlString(value: string): string {
	return JSON.stringify(value)
}

function isBlockScalar(value: string): boolean {
	return /^[|>](?:[+-]?[1-9]?|[1-9][+-]?)$/.test(value)
}

function slugPath(value: string): string {
	return value
		.split(/[\\/]+/g)
		.map((part) => normalizeSkillName(part, "part"))
		.join("--")
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12)
}

function readSkillName(skillDir: string): string {
	const fallbackName = basename(skillDir)
	try {
		const content = readFileSync(join(skillDir, "SKILL.md"), "utf-8")
		const markdown = extractSkillMarkdown(content)
		const name = markdown ? readSkillFrontmatterName(markdown.frontmatter) : undefined
		return normalizeSkillName(name ?? fallbackName, fallbackName)
	} catch {
		return normalizeSkillName(fallbackName)
	}
}

function readSkillNameFromFile(skillFilePath: string, fallbackName: string): string {
	try {
		const content = readFileSync(skillFilePath, "utf-8")
		const markdown = extractSkillMarkdown(content)
		const name = markdown ? readSkillFrontmatterName(markdown.frontmatter) : undefined
		return normalizeSkillName(name ?? fallbackName, fallbackName)
	} catch {
		return normalizeSkillName(fallbackName)
	}
}

function readSkillFrontmatterName(frontmatter: string): string | undefined {
	const parsed = parseSkillFrontmatter(frontmatter)
	if (parsed) return parsed.name

	for (const line of frontmatter.split("\n")) {
		const keyValue = /^name:\s*(.*)$/.exec(line)
		if (keyValue === null) continue
		const value = keyValue[1].trim()
		if (value === "" || isBlockScalar(value)) return undefined
		return stripOuterQuotes(value)
	}
}
