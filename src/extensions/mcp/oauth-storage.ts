import { randomBytes } from "node:crypto"
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type { McpOAuthStorageOptions } from "pi-mcp-adapter/oauth"

export const MCP_OAUTH_STORAGE: McpOAuthStorageOptions = { credentialStore: "encrypted-file" }
const KEY_ENV = "PI_MCP_ADAPTER_OAUTH_FILE_KEY"
const KEY_FILE = "mcp-oauth-file.key"

function validateKey(encoded: string): string {
	const decoded = Buffer.from(encoded, "base64")
	if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
		throw new Error("MCP OAuth encryption key must be canonical base64 for 32 bytes; restore the original key.")
	}
	return encoded
}

function readKey(path: string): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = fstatSync(fd)
		if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
			throw new Error(`MCP OAuth key must be a private regular file (mode 0600): ${path}`)
		}
		if (process.getuid && stat.uid !== process.getuid()) {
			throw new Error(`MCP OAuth key must be owned by the current user: ${path}`)
		}
		return validateKey(readFileSync(fd, "utf8"))
	} finally {
		closeSync(fd)
	}
}

function loadOrCreateKey(agentDir: string): string {
	const path = join(agentDir, KEY_FILE)
	try {
		return readKey(path)
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
	}
	const credentialDir = join(agentDir, "mcp-oauth-encrypted")
	if (
		existsSync(credentialDir) &&
		readdirSync(credentialDir).some((account) => existsSync(join(credentialDir, account, "credentials.json")))
	) {
		throw new Error(`MCP OAuth encryption key is missing. Restore ${path} before reconnecting MCP servers.`)
	}
	mkdirSync(agentDir, { recursive: true, mode: 0o700 })
	const temporary = join(agentDir, `.${KEY_FILE}-${randomBytes(12).toString("hex")}`)
	try {
		const fd = openSync(temporary, "wx", 0o600)
		try {
			writeFileSync(fd, randomBytes(32).toString("base64"), "utf8")
			fsyncSync(fd)
		} finally {
			closeSync(fd)
		}
		try {
			// Publish a complete key without replacing another process's winner.
			linkSync(temporary, path)
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
		}
		return readKey(path)
	} finally {
		rmSync(temporary, { force: true })
	}
}

/** Select the upstream encrypted backend for all sessions, including file-backed UI configs. */
export function configureMcpOAuthStorage(): void {
	process.env.PI_MCP_ADAPTER_OAUTH_CREDENTIAL_STORE = "encrypted-file"
	process.env[KEY_ENV] = process.env[KEY_ENV] ? validateKey(process.env[KEY_ENV]) : loadOrCreateKey(getAgentDir())
}
