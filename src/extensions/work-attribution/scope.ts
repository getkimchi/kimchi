import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { type VerifyApiKeyResponse, verifyApiKey } from "../../api/organizations.js"
import { loadConfig, resolveEndpoints } from "../../config.js"
import { isWorkId } from "../../shared/work-id.js"
import { object } from "./summary.js"

export interface WorkAccount {
	apiUrl: string
	organizationId: string
	userId: string
}

export interface WorkAccountSnapshot {
	account: WorkAccount
	/** Checks the in-memory credential fence; credentials never enter durable work metadata. */
	isCurrent: () => boolean
}
export interface WorkScope {
	account: WorkAccount
	repository: string
}
export interface WorkScopeSnapshot {
	scope: WorkScope
	isCurrent: () => boolean
}

const execFileAsync = promisify(execFile)
export async function workRepository(cwd: string): Promise<string> {
	const { GIT_DIR: _dir, GIT_COMMON_DIR: _common, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...env } = process.env
	const result = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd,
		env,
		timeout: 1000,
		maxBuffer: 4096,
	})
	return realpath(result.stdout.trim())
}

export function sameWorkScope(left: WorkScope, right: WorkScope): boolean {
	return left.repository === right.repository && sameWorkAccount(left.account, right.account)
}

export function isWorkScope(value: unknown): value is WorkScope {
	return object(value) && isWorkAccount(value.account) && typeof value.repository === "string" && !!value.repository
}

export async function captureWorkScope(cwd: string): Promise<WorkScopeSnapshot | undefined> {
	try {
		const captured = await captureWorkAccount(cwd)
		if (!captured?.isCurrent()) return
		const repository = await workRepository(cwd)
		if (captured.isCurrent()) return { scope: { account: captured.account, repository }, isCurrent: captured.isCurrent }
	} catch {
		// A missing account or Git repository cannot authorize a cross-work automatic link.
	}
}

function scopePath(workId: string): string {
	if (!isWorkId(workId)) throw new Error("Invalid work UUID")
	return join(getAgentDir(), "work", workId, "scope.json")
}

export function readWorkScope(workId: string): WorkScope | undefined {
	let fd: number | undefined
	try {
		fd = openSync(scopePath(workId), "r")
		if (fstatSync(fd).size > 8192) return
		const value = JSON.parse(readFileSync(fd, "utf8"))
		if (
			value.version === 1 &&
			value.workId === workId &&
			isWorkAccount(value.account) &&
			typeof value.repository === "string" &&
			value.repository
		)
			return { account: value.account, repository: value.repository }
	} catch {
		// Old, damaged or unavailable scope remains unknown. Never stamp it with today's account.
	} finally {
		if (fd !== undefined) closeSync(fd)
	}
}

/** Only call for a work created in this process. Its original account and repository are immutable. */
export function saveNewWorkScope(workId: string, scope: WorkScope): void {
	const path = scopePath(workId)
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	try {
		writeFileSync(path, `${JSON.stringify({ version: 1, workId, ...scope })}\n`, { mode: 0o600, flag: "wx" })
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
	}
}

let cached: { key: string; apiUrl: string; expiresAt: number; identity: Promise<VerifyApiKeyResponse> } | undefined

export function isWorkAccount(value: unknown): value is WorkAccount {
	return object(value) && typeof value.apiUrl === "string" && isWorkId(value.organizationId) && isWorkId(value.userId)
}

export function sameWorkAccount(left: WorkAccount, right: WorkAccount): boolean {
	return left.apiUrl === right.apiUrl && left.organizationId === right.organizationId && left.userId === right.userId
}

/** Identifies the configured API key and endpoint without keeping the key. */
export function workCredential(cwd: string): string {
	const apiUrl = resolveEndpoints({ cwd }).platformApiUrl.replace(/\/+$/, "")
	return createHash("sha256")
		.update(JSON.stringify([apiUrl, loadConfig({ cwd }).apiKey ?? ""]))
		.digest("hex")
}

/** A short auth cache avoids verifying the same key for every retained intent. */
export async function captureWorkAccount(cwd: string): Promise<WorkAccountSnapshot | undefined> {
	const key = loadConfig({ cwd }).apiKey
	const apiUrl = resolveEndpoints({ cwd }).platformApiUrl.replace(/\/+$/, "")
	if (!key) return
	const isCurrent = () =>
		loadConfig({ cwd }).apiKey === key && resolveEndpoints({ cwd }).platformApiUrl.replace(/\/+$/, "") === apiUrl
	try {
		if (!cached || cached.key !== key || cached.apiUrl !== apiUrl || cached.expiresAt <= Date.now()) {
			cached = {
				key,
				apiUrl,
				expiresAt: Date.now() + 60_000,
				identity: verifyApiKey(key, { endpoint: apiUrl, signal: AbortSignal.timeout(1000), retry: { maxRetries: 0 } }),
			}
		}
		const identity = await cached.identity
		if (!isCurrent()) return
		const account = { apiUrl, ...identity }
		if (isWorkAccount(account)) return { account, isCurrent }
	} catch {
		// Unknown identity disables cross-work inference; ordinary local tracking can continue.
		if (cached?.key === key && cached.apiUrl === apiUrl) cached = undefined
	}
}
