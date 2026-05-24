import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { extract } from "tar"
import { SUPERPOWERS_VERSION, getSuperpowersTarballUrl, getSuperpowersVendorDir } from "./config.js"

export async function ensureSuperpowersInstalled(): Promise<boolean> {
	const vendorDir = getSuperpowersVendorDir()
	const versionFile = join(vendorDir, ".version")
	const skillsDir = join(vendorDir, "skills")

	// Idempotency check: version file must exist AND match pinned version
	if (existsSync(versionFile) && existsSync(skillsDir)) {
		const installed = readFileSync(versionFile, "utf-8").trim()
		if (installed === SUPERPOWERS_VERSION) return false
	}

	mkdirSync(vendorDir, { recursive: true })

	const url = getSuperpowersTarballUrl()
	const tarballPath = join(vendorDir, "download.tar.gz")

	const response = await fetch(url)
	if (!response.ok) {
		throw new Error(`Failed to download superpowers: ${response.status} ${response.statusText}`)
	}

	// Stream response body to disk
	await new Promise<void>((resolve, reject) => {
		const stream = createWriteStream(tarballPath)
		stream.on("finish", resolve)
		stream.on("error", reject)
		// biome-ignore lint/style/noNonNullAssertion: fetch guarantees body when ok
		const reader = response.body!.getReader()
		function pump(): void {
			reader.read().then(({ done, value }) => {
				if (done) {
					stream.end()
					return
				}
				stream.write(value)
				pump()
			}, reject)
		}
		pump()
	})

	// Extract tarball, stripping the top-level "superpowers-<version>/" directory
	rmSync(vendorDir, { recursive: true, force: true })
	mkdirSync(vendorDir, { recursive: true })
	await extract({ file: tarballPath, cwd: vendorDir, strip: 1 })

	// Write version marker after successful extraction
	writeFileSync(versionFile, SUPERPOWERS_VERSION)

	// Clean up tarball
	await unlink(tarballPath).catch(() => undefined)

	return true
}
