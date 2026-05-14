import { createWriteStream } from "node:fs"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadable } from "node:stream/web"

const DEFAULT_API_BASE = "https://api.github.com"
const DEFAULT_DOWNLOAD_BASE = "https://github.com"

export interface Repo {
	owner: string
	name: string
	/** Binary name inside the tar.gz (also the prefix of the asset filename). */
	binary: string
}

export interface ReleaseInfo {
	tagName: string
	htmlUrl: string
}

export interface CanaryReleaseInfo {
	tagName: string
	targetCommitish: string
	htmlUrl: string
	/** Release title, e.g. "Canary 0.0.0-canary.20260509.abc1234". */
	name: string
}

export interface GitHubClientOptions {
	apiBase?: string
	downloadBase?: string
	fetch?: typeof globalThis.fetch
}

export const KIMCHI_REPO: Repo = { owner: "castai", name: "kimchi-dev", binary: "kimchi" }

/** Map node `process.platform` → the goreleaser-style OS slug used in asset names. */
function osSlug(): string {
	switch (process.platform) {
		case "darwin":
			return "darwin"
		case "linux":
			return "linux"
		case "win32":
			return "windows"
		default:
			throw new Error(`unsupported platform: ${process.platform}`)
	}
}

/** Map node `process.arch` → the goreleaser-style arch slug. */
function archSlug(): string {
	switch (process.arch) {
		case "x64":
			return "amd64"
		case "arm64":
			return "arm64"
		default:
			throw new Error(`unsupported architecture: ${process.arch}`)
	}
}

export function assetName(repo: Repo): string {
	const ext = process.platform === "win32" ? "zip" : "tar.gz"
	return `${repo.binary}_${osSlug()}_${archSlug()}.${ext}`
}

export class GitHubClient {
	private readonly apiBase: string
	private readonly downloadBase: string
	private readonly fetchImpl: typeof globalThis.fetch

	constructor(opts: GitHubClientOptions = {}) {
		this.apiBase = opts.apiBase ?? DEFAULT_API_BASE
		this.downloadBase = opts.downloadBase ?? DEFAULT_DOWNLOAD_BASE
		this.fetchImpl = opts.fetch ?? globalThis.fetch
	}

	/** GET /repos/{owner}/{name}/releases/latest. Returns tag + URL. */
	async latestRelease(repo: Repo): Promise<ReleaseInfo> {
		const url = `${this.apiBase}/repos/${repo.owner}/${repo.name}/releases/latest`
		const res = await this.fetchImpl(url, {
			headers: { Accept: "application/vnd.github+json" },
		})
		if (!res.ok) {
			throw new Error(`github API returned ${res.status}`)
		}
		const json = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
		if (typeof json.tag_name !== "string" || json.tag_name.length === 0) {
			throw new Error("github API response missing tag_name")
		}
		return {
			tagName: json.tag_name,
			htmlUrl: typeof json.html_url === "string" ? json.html_url : "",
		}
	}

	/** GET /repos/{owner}/{name}/releases/tags/canary. */
	async canaryRelease(repo: Repo): Promise<CanaryReleaseInfo> {
		const url = `${this.apiBase}/repos/${repo.owner}/${repo.name}/releases/tags/canary`
		const res = await this.fetchImpl(url, {
			headers: { Accept: "application/vnd.github+json" },
		})
		if (!res.ok) {
			throw new Error(`github API returned ${res.status}`)
		}
		const json = (await res.json()) as {
			tag_name?: unknown
			html_url?: unknown
			target_commitish?: unknown
			name?: unknown
		}
		if (typeof json.tag_name !== "string" || json.tag_name.length === 0) {
			throw new Error("github API response missing tag_name")
		}
		if (typeof json.target_commitish !== "string" || json.target_commitish.length === 0) {
			throw new Error("github API response missing target_commitish")
		}
		return {
			tagName: json.tag_name,
			targetCommitish: json.target_commitish,
			htmlUrl: typeof json.html_url === "string" ? json.html_url : "",
			name: typeof json.name === "string" ? json.name : "",
		}
	}

	/**
	 * Fetch the SHA-256 checksum for our platform's asset out of the release's
	 * checksums.txt. Returns the raw 32-byte hash. Throws if the file is
	 * missing or has no entry for our asset.
	 */
	async fetchChecksum(repo: Repo, tag: string): Promise<Uint8Array> {
		const url = `${this.downloadBase}/${repo.owner}/${repo.name}/releases/download/${tag}/checksums.txt`
		const res = await this.fetchImpl(url)
		if (!res.ok) {
			throw new Error(`checksums.txt download returned ${res.status}`)
		}
		const text = await res.text()
		const target = assetName(repo)
		for (const line of text.split("\n")) {
			const parts = line.trim().split(/\s+/)
			if (parts.length === 2 && parts[1] === target) {
				return hexDecode(parts[0])
			}
		}
		throw new Error(`checksum not found for ${target}`)
	}

	/** Download the platform asset to `dest`. Streams body to disk. */
	async downloadArchive(repo: Repo, tag: string, dest: string): Promise<void> {
		const url = `${this.downloadBase}/${repo.owner}/${repo.name}/releases/download/${tag}/${assetName(repo)}`
		const res = await this.fetchImpl(url)
		if (!res.ok || !res.body) {
			throw new Error(`release download returned ${res.status}`)
		}
		const sink = createWriteStream(dest)
		// fetch's body is a Web ReadableStream; convert via Readable.fromWeb so we
		// can pipe it through pipeline() with proper backpressure + cleanup.
		const source = Readable.fromWeb(res.body as WebReadable<Uint8Array>)
		await pipeline(source, sink)
	}
}

function hexDecode(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) {
		throw new Error(`invalid checksum hex length: ${hex.length}`)
	}
	const out = new Uint8Array(hex.length / 2)
	for (let i = 0; i < out.length; i++) {
		const byte = Number.parseInt(hex.substr(i * 2, 2), 16)
		if (Number.isNaN(byte)) {
			throw new Error(`invalid checksum hex at offset ${i * 2}`)
		}
		out[i] = byte
	}
	return out
}
