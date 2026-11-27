import { basename } from "node:path"
import { type ParseEntry, parse as parseShell } from "shell-quote"

function program(token: string | undefined): string {
	return token
		? basename(token)
				.toLowerCase()
				.replace(/\.(?:cmd|exe|bat)$/, "")
		: ""
}

function has(tokens: readonly string[], values: readonly string[]): boolean {
	return tokens.some((token) => values.includes(token.toLowerCase()))
}

const VALUE_GLOBAL_OPTIONS = new Set([
	"--registry",
	"--cache",
	"--prefix",
	"--userconfig",
	"--globalconfig",
	"--location",
	"--workspace",
	"--workspaces",
	"--filter",
	"--proxy",
	"--https-proxy",
	"--script-shell",
	"--init-module",
	"--tmp",
	"--cwd",
])

function packageManagerSubcommand(tokens: readonly string[]): string | undefined {
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index] ?? ""
		if (token === "--") return undefined
		if (token.startsWith("-")) {
			if (VALUE_GLOBAL_OPTIONS.has(token)) index++
			continue
		}
		return token.toLowerCase()
	}
	return undefined
}

function directInvocation(tokens: readonly string[], depth: number): boolean {
	if (!tokens.length) return false
	const name = program(tokens[0])
	const args = tokens.slice(1).map((token) => token.toLowerCase())
	if (["npm", "pnpm"].includes(name)) {
		const subcommand = packageManagerSubcommand(tokens)
		return (
			["install", "i", "add", "ci", "exec", "x"].includes(subcommand ?? "") || (name === "pnpm" && subcommand === "dlx")
		)
	}
	if (name === "yarn") {
		const subcommand = packageManagerSubcommand(tokens)
		return args.length === 0 || ["install", "add", "dlx", "exec"].includes(subcommand ?? "")
	}
	if (name === "bun") return has(args, ["install", "i", "add"])
	if (["npx", "bunx", "pnpx"].includes(name)) return true
	if (["pip", "pip3"].includes(name)) return has(args, ["install"])
	if (["python", "python3"].includes(name) && args[0] === "-m" && args[1] === "pip" && args.includes("install")) {
		return true
	}
	if (name === "uv") return (args[0] === "pip" && args.includes("install")) || has(args, ["add"])
	if (name === "poetry") return has(args, ["install", "add"])
	if (name === "go") return has(args, ["get", "install"])
	if (name === "cargo") return has(args, ["install", "add"])
	if (name === "bundle") return has(args, ["install", "add"])
	if (name === "composer") return has(args, ["install", "require", "update"])
	if (["apt", "apt-get", "apk", "dnf", "yum", "brew"].includes(name)) return has(args, ["install", "add"])
	if (name === "bash" || name === "sh" || name === "zsh") {
		const commandFlag = args.findIndex((token) => /^-[a-z]*c[a-z]*$/.test(token))
		const script = commandFlag >= 0 ? tokens.slice(commandFlag + 2).join(" ") : undefined
		return script !== undefined && script.length > 0 && detect(script, depth + 1)
	}
	if (name === "env" && (args.includes("-s") || args.includes("--split-string"))) {
		const splitIndex = args.findIndex((token) => token === "-s" || token === "--split-string")
		return detect(tokens.slice(splitIndex + 2).join(" "), depth + 1)
	}
	if (["env", "command", "nohup", "time", "nice", "timeout", "xargs"].includes(name)) {
		return detectInvocationTokens(tokens.slice(1), depth + 1)
	}
	if (name === "eval") return detect(tokens.slice(1).join(" "), depth + 1)
	return false
}

function corepackMutation(tokens: readonly string[], depth: number): boolean {
	const operation = tokens[0]?.toLowerCase()
	if (["prepare", "use", "install", "up", "enable", "pack"].includes(operation ?? "")) return true
	if (/(?:^|@)(?:pnpm|yarn|npm)@/.test(operation ?? "") || /^(?:@[^/]+\/)?[^@]+@/.test(operation ?? "")) return true
	return directInvocation(tokens, depth)
}

function detectInvocationTokens(tokens: readonly string[], depth: number): boolean {
	if (depth > 12) return true
	const candidates = [...tokens]
	while (candidates.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(candidates[0] ?? "")) candidates.shift()
	if (!candidates.length) return false
	const name = program(candidates[0])
	if (name === "corepack") return corepackMutation(candidates.slice(1), depth + 1)
	if (directInvocation(candidates, depth)) return true
	if (["env", "command", "nohup", "time", "nice", "timeout", "xargs"].includes(name)) {
		for (let index = 1; index < candidates.length; index++) {
			const suffix = candidates.slice(index)
			const token = suffix[0] ?? ""
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token.startsWith("-")) continue
			if (directInvocation(suffix, depth + 1)) return true
		}
	}
	return false
}

function detectEntries(entries: readonly ParseEntry[], depth: number): boolean {
	let segment: string[] = []
	const inspect = () => {
		const result = detectInvocationTokens(segment, depth)
		segment = []
		return result
	}
	for (const entry of entries) {
		if (typeof entry === "string") {
			segment.push(entry)
			continue
		}
		if ("comment" in entry) continue
		if ("op" in entry) {
			if (["&&", "||", ";", "|", "|&", "(", ")"].includes(entry.op)) {
				if (inspect()) return true
				continue
			}
			if (entry.op === "glob") {
				segment.push(entry.pattern)
				continue
			}
			segment.push(entry.op)
		}
	}
	return inspect()
}

function detect(command: string, depth: number): boolean {
	if (!command.trim()) return false
	if (depth > 12) return true
	for (const match of command.matchAll(/`([^`]*)`/g)) {
		if (match[1] && detect(match[1], depth + 1)) return true
	}
	try {
		return detectEntries(parseShell(command) as ParseEntry[], depth)
	} catch {
		// Malformed nesting fails toward an explicit approval decision, never a
		// policy bypass by virtue of parser uncertainty.
		return true
	}
}

/** Shell-aware dependency/toolchain mutation detection using the same parser
 * family as the inherited Bash permission taxonomy. */
export function isDirectInstallCommand(command: string): boolean {
	return detect(command, 0)
}
