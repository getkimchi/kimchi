import { hasBearerAuthorizationHeader } from "../../agent-discovery/engine.js"
import { readAllGitTokens, readApiKeyFromConfigFile } from "../../config.js"
import { loadMcpConfig } from "../mcp-adapter/config.js"
import type { ServerEntry } from "../mcp-adapter/types.js"

const MIN_SECRET_LENGTH = 8

/**
 * Env var names that match this regex are treated as secret-bearing.
 * Matches anything containing API_KEY, TOKEN, SECRET, PASSWORD, or CREDENTIAL
 * (case-insensitive). The values of these env vars are added to the
 * known-secrets set for exact-match redaction in tool output.
 */
const SECRET_ENV_VAR_PATTERN = /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

/**
 * Resolve `$VAR` and `${VAR}` env-var interpolation in a string value.
 * Returns the resolved string, or the original if no interpolation is needed.
 */
function resolveEnvVars(value: string): string {
	return value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name: string) => {
		return process.env[name] ?? ""
	})
}

/**
 * Extract bearer token value from an Authorization header string.
 * Returns the token (without "Bearer " prefix) or undefined.
 */
function extractBearerToken(headerValue: string): string | undefined {
	const match = /^[Bb]earer\s+(.+)$/.exec(headerValue.trim())
	return match?.[1]
}

/**
 * Collect known secrets from kimchi config and MCP server definitions.
 * Called at session_start. Returns a Set<string> of secret values.
 *
 * Sources:
 * 1. API key from config file and process.env.KIMCHI_API_KEY
 * 2. All git token values from config file
 * 3. MCP server bearer tokens (headers, bearerToken, bearerTokenEnv)
 *
 * Never throws — returns empty set on any failure.
 */
export function collectKnownSecrets(): Set<string> {
	const secrets = new Set<string>()

	try {
		// 1. API key from config file
		const fileApiKey = readApiKeyFromConfigFile()
		if (fileApiKey && fileApiKey.length >= MIN_SECRET_LENGTH) {
			secrets.add(fileApiKey)
		}

		// 1b. Secret values from env vars whose names match API_KEY, TOKEN, SECRET,
		//      PASSWORD, or CREDENTIAL (case-insensitive). This catches
		//      ANTHROPIC_API_KEY, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, etc.
		//      without hardcoding a list of provider names.
		for (const [varName, value] of Object.entries(process.env)) {
			if (SECRET_ENV_VAR_PATTERN.test(varName) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
				secrets.add(value)
			}
		}
	} catch {
		// Config read failed — continue with other sources
	}

	try {
		// 2. Git tokens
		const gitTokens = readAllGitTokens()
		if (gitTokens) {
			for (const token of Object.values(gitTokens)) {
				if (typeof token === "string" && token.length >= MIN_SECRET_LENGTH) {
					secrets.add(token)
				}
			}
		}
	} catch {
		// Git token read failed — continue
	}

	try {
		// 3. MCP bearer tokens
		const { config } = loadMcpConfig()
		for (const entry of Object.values(config.mcpServers)) {
			collectMcpBearerTokens(entry, secrets)
		}
	} catch {
		// MCP config read failed — continue
	}

	return secrets
}

/**
 * Collect bearer tokens from a single MCP server entry.
 */
function collectMcpBearerTokens(entry: ServerEntry, secrets: Set<string>): void {
	// 3a. Headers with Authorization: Bearer
	if (entry.headers && hasBearerAuthorizationHeader(entry.headers)) {
		for (const [key, value] of Object.entries(entry.headers)) {
			if (key.toLowerCase() === "authorization") {
				const resolved = resolveEnvVars(value)
				const token = extractBearerToken(resolved)
				if (token && token.length >= MIN_SECRET_LENGTH) {
					secrets.add(token)
				}
			}
		}
	}

	// 3b. bearerToken field (literal token)
	if (entry.bearerToken && entry.bearerToken.length >= MIN_SECRET_LENGTH) {
		secrets.add(entry.bearerToken)
	}

	// 3c. bearerTokenEnv field (env var name → resolve value)
	if (entry.bearerTokenEnv) {
		const token = process.env[entry.bearerTokenEnv]
		if (token && token.length >= MIN_SECRET_LENGTH) {
			secrets.add(token)
		}
	}
}
