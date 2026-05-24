import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { chmod, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
import { settingsPath } from "./store.js"

const LATEST_RELEASE_URL = "https://api.github.com/repos/rtk-ai/rtk/releases/latest"
const AUTO_INSTALL_INTERVAL_MS = 24 * 60 * 60 * 1000

interface GitHubRelease {
	tag_name: string
	assets: Array<{
		name: string
		browser_download_url: string
		digest?: string
	}>
}

export interface RtkInstallResult {
	version: string
	binaryPath: string
	linkPath: string
}

let installPromise: Promise<RtkInstallResult> | undefined

export function managedRtkPath(): string {
	return join(rtkInstallDir(), process.platform === "win32" ? "rtk.exe" : "rtk")
}

export function globalRtkLinkPath(): string {
	return join(globalBinDir(), process.platform === "win32" ? "rtk.exe" : "rtk")
}

export function ensureRtkPath(): void {
	const bin = globalBinDir()
	const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
	if (!entries.includes(bin)) process.env.PATH = [bin, ...entries].join(delimiter)
}

export function isRtkCommandAvailable(): boolean {
	try {
		execFileSync("rtk", ["--version"], { stdio: "ignore", timeout: 1000 })
		return true
	} catch {
		return false
	}
}

export function isRtkInstalled(): boolean {
	if (existsSync(globalRtkLinkPath())) return true
	if (existsSync(managedRtkPath())) return true
	return isRtkCommandAvailable()
}

export function installedRtkVersion(): string | undefined {
	for (const binary of [globalRtkLinkPath(), managedRtkPath(), "rtk"]) {
		const version = rtkVersion(binary)
		if (version) return version
	}
	return undefined
}

export function shouldCheckRtkAutoInstall(now = Date.now(), path = settingsPath()): boolean {
	const settings = readFullSettings(path)
	const checkedAt = typeof settings.rtkAutoInstallCheckedAt === "number" ? settings.rtkAutoInstallCheckedAt : 0
	return now - checkedAt > AUTO_INSTALL_INTERVAL_MS
}

export function markRtkAutoInstallChecked(now = Date.now(), path = settingsPath()): void {
	const settings = readFullSettings(path)
	settings.rtkAutoInstallCheckedAt = now
	writeFullSettings(path, settings)
}

export async function installRtk(): Promise<RtkInstallResult> {
	if (installPromise) return installPromise
	installPromise = installRtkUnlocked().finally(() => {
		installPromise = undefined
	})
	return installPromise
}

async function installRtkUnlocked(): Promise<RtkInstallResult> {
	const release = await fetchJson<GitHubRelease>(LATEST_RELEASE_URL)
	const managedPath = managedRtkPath()
	const globalPath = globalRtkLinkPath()
	const managedVersion = rtkVersion(managedPath)
	const globalVersion = rtkVersion(globalPath)
	if (managedVersion === release.tag_name) {
		const linkPath = globalVersion === release.tag_name ? globalPath : linkGlobalRtk(managedPath)
		ensureRtkPath()
		return { version: release.tag_name, binaryPath: managedPath, linkPath }
	}
	if (globalVersion === release.tag_name) {
		ensureRtkPath()
		return { version: release.tag_name, binaryPath: globalPath, linkPath: globalPath }
	}

	const asset = selectAsset(release)
	const archive = await download(asset.browser_download_url)
	verifyDigest(asset, archive)

	const tempDir = mkdtempSync(join(tmpdir(), "kimchi-rtk-"))
	try {
		const archivePath = join(tempDir, asset.name)
		await writeFile(archivePath, archive)
		const extractDir = join(tempDir, "extract")
		mkdirSync(extractDir, { recursive: true })
		extractArchive(archivePath, extractDir)
		const extracted = findExtractedRtk(extractDir)
		const target = managedRtkPath()
		mkdirSync(dirname(target), { recursive: true })
		replaceFile(extracted, target)
		if (process.platform !== "win32") await chmod(target, 0o755)
		const linkPath = linkGlobalRtk(target)
		ensureRtkPath()
		return { version: release.tag_name, binaryPath: target, linkPath }
	} finally {
		rmSync(tempDir, { recursive: true, force: true })
	}
}

function rtkInstallDir(): string {
	return join(process.env.KIMCHI_CODING_AGENT_DIR ?? join(homedir(), ".config", "kimchi", "harness"), "rtk")
}

function globalBinDir(): string {
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "kimchi", "bin")
	}
	return join(homedir(), ".local", "bin")
}

function linkGlobalRtk(target: string): string {
	const linkPath = globalRtkLinkPath()
	mkdirSync(dirname(linkPath), { recursive: true })

	if (process.platform === "win32") {
		replaceFile(target, linkPath)
		return linkPath
	}

	const tmpLink = `${linkPath}.${process.pid}.${Date.now()}.tmp`
	rmSync(tmpLink, { force: true })
	symlinkSync(target, tmpLink)
	renameSync(tmpLink, linkPath)
	return linkPath
}

function replaceFile(src: string, dest: string): void {
	const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
	copyFileSync(src, tmp)
	renameSync(tmp, dest)
}

function rtkVersion(binary: string): string | undefined {
	try {
		const output = execFileSync(binary, ["--version"], { encoding: "utf-8", timeout: 1000 })
		const match = output.match(/\d+\.\d+\.\d+/)
		return match ? `v${match[0]}` : undefined
	} catch {
		return undefined
	}
}

function readFullSettings(path: string): Record<string, unknown> {
	try {
		const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {}
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

function writeFullSettings(path: string, settings: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
}

function selectAsset(release: GitHubRelease): GitHubRelease["assets"][number] {
	const wanted = assetName()
	const asset = release.assets.find((candidate) => candidate.name === wanted)
	if (!asset) throw new Error(`RTK release ${release.tag_name} has no asset for ${process.platform}/${process.arch}`)
	return asset
}

function assetName(): string {
	if (process.platform === "darwin") {
		if (process.arch === "arm64") return "rtk-aarch64-apple-darwin.tar.gz"
		if (process.arch === "x64") return "rtk-x86_64-apple-darwin.tar.gz"
	}
	if (process.platform === "linux") {
		if (process.arch === "arm64") return "rtk-aarch64-unknown-linux-gnu.tar.gz"
		if (process.arch === "x64") return "rtk-x86_64-unknown-linux-musl.tar.gz"
	}
	if (process.platform === "win32" && process.arch === "x64") return "rtk-x86_64-pc-windows-msvc.zip"
	throw new Error(`Unsupported RTK platform: ${process.platform}/${process.arch}`)
}

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url, { headers: requestHeaders() })
	if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
	return (await res.json()) as T
}

async function download(url: string): Promise<Buffer> {
	const res = await fetch(url, { headers: requestHeaders() })
	if (!res.ok) throw new Error(`Failed to download ${basename(url)}: ${res.status}`)
	return Buffer.from(await res.arrayBuffer())
}

function requestHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "kimchi",
	}
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
	if (token) headers.Authorization = `Bearer ${token}`
	return headers
}

function verifyDigest(asset: GitHubRelease["assets"][number], archive: Buffer): void {
	if (!asset.digest?.startsWith("sha256:"))
		throw new Error(`RTK release asset ${asset.name} is missing a sha256 digest`)
	const expected = asset.digest.slice("sha256:".length)
	const actual = createHash("sha256").update(archive).digest("hex")
	if (actual !== expected) throw new Error(`RTK checksum mismatch for ${asset.name}`)
}

function extractArchive(archivePath: string, extractDir: string): void {
	if (archivePath.endsWith(".zip")) {
		execFileSync("powershell.exe", [
			"-NoProfile",
			"-Command",
			"Expand-Archive",
			"-LiteralPath",
			archivePath,
			"-DestinationPath",
			extractDir,
			"-Force",
		])
		return
	}
	execFileSync("tar", ["-xzf", archivePath, "-C", extractDir])
}

function findExtractedRtk(dir: string): string {
	const wanted = process.platform === "win32" ? "rtk.exe" : "rtk"
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isFile() && entry.name === wanted) return path
		if (entry.isDirectory()) {
			try {
				return findExtractedRtk(path)
			} catch {
				// Keep searching siblings.
			}
		}
	}
	throw new Error("RTK archive did not contain rtk binary")
}
