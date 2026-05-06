import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compareSemverGte } from "../integrations/opencode.js"
import { extractTarGz, verifyChecksum } from "./extract.js"
import { GitHubClient, KIMCHI_REPO, type Repo } from "./github.js"
import { atomicInstall, copySupportingFiles, macosCodesignReSign, smokeTestBinary } from "./install.js"
import { resolveDataDir, resolveExecutablePath } from "./paths.js"
import { isStale, isUpdateCheckDisabled, loadRepoState, saveRepoState } from "./state.js"

export interface CheckResult {
	currentVersion: string
	latestVersion: string
	releaseUrl: string
	hasUpdate: boolean
	cached: boolean
}

export interface UpdateResult {
	from: string
	to: string
	backupPath?: string
}

export interface CheckOptions {
	repo?: Repo
	skipCache?: boolean
	currentVersion: string
	client?: GitHubClient
}

/**
 * Resolve the latest release for `repo`, hitting the 24h-cached state file
 * when fresh and falling back to the GitHub API otherwise. Honors
 * $KIMCHI_NO_UPDATE_CHECK by short-circuiting to a "no update" result.
 *
 * The CheckOptions.currentVersion is mandatory because we read it from
 * package.json (already in scope at the caller) rather than re-resolving
 * here — keeps this module IO-light.
 */
export async function checkForUpdate(opts: CheckOptions): Promise<CheckResult> {
	const repo = opts.repo ?? KIMCHI_REPO
	const client = opts.client ?? new GitHubClient()

	if (isUpdateCheckDisabled()) {
		return {
			currentVersion: opts.currentVersion,
			latestVersion: opts.currentVersion,
			releaseUrl: "",
			hasUpdate: false,
			cached: false,
		}
	}

	let latestVersion = ""
	let releaseUrl = ""
	let cached = false

	if (!opts.skipCache) {
		const cachedState = loadRepoState(repo.owner, repo.name)
		if (cachedState && !isStale(cachedState)) {
			latestVersion = cachedState.latest_version
			releaseUrl = cachedState.release_url ?? ""
			cached = true
		}
	}

	if (latestVersion === "") {
		const info = await client.latestRelease(repo)
		latestVersion = info.tagName
		releaseUrl = info.htmlUrl
		saveRepoState(repo.owner, repo.name, {
			checked_at: new Date().toISOString(),
			latest_version: latestVersion,
			release_url: releaseUrl,
		})
	}

	// GitHub release tags carry a leading "v" (e.g. "v0.0.23"); compareSemverGte
	// only parses bare semver, so strip the prefix here. We keep `latestVersion`
	// itself unchanged so cached state and user-facing messages still show the
	// canonical tag name.
	const tag = (latestVersion ?? "").replace(/^v/, "")
	const hasUpdate = tag !== "" && !compareSemverGte(opts.currentVersion, tag)
	return {
		currentVersion: opts.currentVersion,
		latestVersion,
		releaseUrl,
		hasUpdate,
		cached,
	}
}

export interface UpdateOptions {
	repo?: Repo
	tag: string
	client?: GitHubClient
	executablePath?: string
}

/**
 * Download → verify checksum → extract → smoke-test → atomic install.
 * Throws on any step's failure with the original error wrapped in context.
 *
 * Cleans up the temp tarball + extract dir even on failure (try/finally).
 *
 * macOS Gatekeeper requires the new binary to be ad-hoc signed before the
 * swap; the binary's signature gets baked into the inode, so we sign at
 * the new path before rename.
 *
 * On Windows the install rotates `kimchi.exe` → `kimchi.exe.old` and drops
 * the new exe in. The .old is cleaned up by the next launch (the new
 * binary can delete it because we're no longer it).
 */
export async function applyUpdate(opts: UpdateOptions): Promise<UpdateResult> {
	const repo = opts.repo ?? KIMCHI_REPO
	const client = opts.client ?? new GitHubClient()
	const targetPath = opts.executablePath ?? resolveExecutablePath()

	const workDir = mkdtempSync(join(tmpdir(), "kimchi-update-"))
	try {
		const archiveName = `${repo.binary}.archive`
		const archivePath = join(workDir, archiveName)

		const expectedChecksum = await client.fetchChecksum(repo, opts.tag)
		await client.downloadArchive(repo, opts.tag, archivePath)
		await verifyChecksum(archivePath, expectedChecksum)

		const extractedRoot = await extractTarGz(archivePath)
		try {
			const binaryPath = join("bin", repo.binary)
			const newBinaryPath = join(extractedRoot, binaryPath)
			macosCodesignReSign(newBinaryPath)
			smokeTestBinary(newBinaryPath)
			const { backupPath } = atomicInstall(newBinaryPath, targetPath)

			// Copy supporting files after binary is installed.
			const shareSrc = join(extractedRoot, "share", "kimchi")
			const shareDst = resolveDataDir()
			copySupportingFiles(shareSrc, shareDst, repo.binary)

			return { from: opts.tag, to: opts.tag, backupPath }
		} finally {
			rmSync(extractedRoot, { recursive: true, force: true })
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true })
	}
}
