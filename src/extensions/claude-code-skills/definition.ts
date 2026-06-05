import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import type { Dirent } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { z } from "zod"

export const CLAUDE_CODE_SKILLS_RESOURCE_ID = "extensions.claude-code-skills"

interface ClaudeCodeSkillResourceOptions {
	excludeNativeSkillNames?: boolean
	excludeSkillNames?: Iterable<string>
	excludeSkillPaths?: string[]
}

const SkillFrontmatterSchema = z
	.object({
		name: z.string().optional(),
		description: z.string().optional(),
	})
	.catchall(z.unknown())

type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

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
	if (options.excludeNativeSkillNames !== false) {
		for (const name of getNativeSkillNames(cwd, options.excludeSkillPaths ?? [])) {
			excludedSkillNames.add(name)
		}
	}

	const paths: string[] = []
	for (const dir of discoverClaudeCodeSkillDirs(cwd)) {
		paths.push(...materializeClaudeCodeSkillDir(dir, { excludeSkillNames: excludedSkillNames }))
	}
	return paths
}

export function materializeClaudeCodeSkillDir(
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

export function sanitizeSkillMarkdown(content: string, fallbackName: string): string {
	const markdown = extractSkillMarkdown(content)
	if (markdown === undefined) return content

	return ["---", sanitizeFrontmatter(markdown.frontmatter, fallbackName), "---", markdown.body.replace(/^\n/, "")].join(
		"\n",
	)
}

function getClaudeCodeSkillsCacheDir(): string {
	return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "kimchi", "claude-code-skills")
}

function walkSkillDirs(dir: string): string[] {
	const results: string[] = []
	walkSkillDirsInto(dir, results)
	return results
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
	const sanitized: Record<string, unknown> = { name }
	for (const [key, value] of Object.entries(frontmatter)) {
		if (key === "name" || isToolsFrontmatterKey(key)) continue
		sanitized[key] = value
	}
	return stringifyYaml(sanitized).trimEnd()
}

function sanitizeLooseFrontmatter(frontmatter: string, fallbackName: string): string {
	const lines = frontmatter.split("\n")
	const sanitized: string[] = []
	let hasName = false

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
			sanitized.push(`name: ${quoteYamlString(normalizeSkillName(stripOuterQuotes(value), fallbackName))}`)
			continue
		}

		if (value === "" || isBlockScalar(value)) {
			sanitized.push(line)
			continue
		}

		sanitized.push(`${key}: ${formatLooseYamlScalar(value)}`)
	}

	if (!hasName) {
		sanitized.unshift(`name: ${quoteYamlString(normalizeSkillName(fallbackName))}`)
	}

	return sanitized.join("\n")
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
	return value === "|" || value === ">" || value.startsWith("|+") || value.startsWith("|-") || value.startsWith(">+")
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

function getNativeSkillNames(cwd: string, configuredSkillPaths: string[]): Set<string> {
	return collectSkillNames([
		...discoverNativeSkillDirs(cwd),
		...excludeClaudeCodeSkillPaths(expandConfiguredSkillPaths(configuredSkillPaths, cwd), cwd),
	])
}

function excludeClaudeCodeSkillPaths(paths: string[], cwd: string): string[] {
	const claudeCodeSkillDirs = discoverClaudeCodeSkillDirs(cwd).map((dir) => resolve(dir))
	if (claudeCodeSkillDirs.length === 0) return paths
	return paths.filter((path) => {
		const resolved = resolve(path)
		return !claudeCodeSkillDirs.some((dir) => isSameOrDescendant(resolved, dir))
	})
}

function isSameOrDescendant(path: string, parent: string): boolean {
	const relativePath = relative(parent, path)
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

function discoverNativeSkillDirs(cwd: string): string[] {
	const ancestorAgentsSkills = findNearestAncestorSkillDir(cwd, join(".agents", "skills"))
	const dirs = [
		resolve(cwd, ".pi", "skills"),
		...(ancestorAgentsSkills ? [ancestorAgentsSkills] : []),
		join(homedir(), ".config", "kimchi", "harness", "skills"),
		join(homedir(), ".pi", "agent", "skills"),
		join(homedir(), ".agents", "skills"),
	]

	const seen = new Set<string>()
	const result: string[] = []
	for (const dir of dirs) {
		const resolved = resolve(dir)
		if (seen.has(resolved) || !existsSync(resolved)) continue
		seen.add(resolved)
		result.push(resolved)
	}
	return result
}

export function findNearestAncestorSkillDir(cwd: string, relativeSkillDir: string): string | undefined {
	let dir = resolve(cwd)
	while (true) {
		const skillDir = join(dir, relativeSkillDir)
		if (existsSync(skillDir)) return skillDir
		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}

export function expandConfiguredSkillPaths(paths: string[], cwd: string): string[] {
	const home = homedir()
	const expanded: string[] = []
	for (const path of paths) {
		if (isAbsolute(path)) {
			expanded.push(path)
		} else if (path.startsWith("~/")) {
			expanded.push(resolve(home, path.slice(2)))
		} else {
			expanded.push(resolve(home, path), resolve(cwd, path))
		}
	}
	return expanded
}

function collectSkillNames(paths: string[]): Set<string> {
	const names = new Set<string>()
	const seen = new Set<string>()

	for (const path of paths) {
		const resolved = resolve(path)
		if (seen.has(resolved) || !existsSync(resolved)) continue
		seen.add(resolved)

		if (isSkillMarkdownFile(resolved)) {
			names.add(readSkillName(dirname(resolved)))
			continue
		}

		if (!isDirectory(resolved)) continue
		for (const skillDir of walkSkillDirs(resolved)) {
			names.add(readSkillName(skillDir))
		}
	}

	return names
}

function isSkillMarkdownFile(path: string): boolean {
	try {
		return basename(path) === "SKILL.md" && statSync(path).isFile()
	} catch {
		return false
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
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
