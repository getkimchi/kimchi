import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { extract } from "tar"
import { SUPERPOWERS_VERSION, getSuperpowersTarballUrl, getSuperpowersVendorDir } from "./config.js"

export async function ensureSuperpowersInstalled(): Promise<boolean> {
	const vendorDir = getSuperpowersVendorDir()
	const versionFile = join(vendorDir, ".version")
	const skillsDir = join(vendorDir, "skills")

	// Idempotency check: both markers must exist and version must match
	if (existsSync(versionFile) && existsSync(skillsDir)) {
		const installed = readFileSync(versionFile, "utf-8").trim()
		if (installed === SUPERPOWERS_VERSION) return false
	}

	// Download to a sibling temp file OUTSIDE vendorDir.
	// This ensures rmSync(vendorDir) below cannot delete the tarball.
	// Create the parent dir first so createWriteStream doesn't throw ENOENT.
	const tarballPath = `${vendorDir}.download.tar.gz`
	mkdirSync(vendorDir, { recursive: true })

	const response = await fetch(getSuperpowersTarballUrl())
	if (!response.ok) {
		throw new Error(`Failed to download superpowers: ${response.status} ${response.statusText}`)
	}

	try {
		// Stream response body to the temp tarball path
		await new Promise<void>((resolve, reject) => {
			const stream = createWriteStream(tarballPath)
			stream.on("finish", resolve)
			stream.on("error", reject)
			// biome-ignore lint/style/noNonNullAssertion: fetch guarantees body when ok
			const reader = response.body!.getReader()
			function pump(): void {
				reader.read().then(
					({ done, value }) => {
						if (done) {
							stream.end()
							return
						}
						stream.write(value)
						pump()
					},
					(err) => {
						stream.destroy()
						reject(err)
					},
				)
			}
			pump()
		})

		// Download succeeded — now safe to wipe vendorDir and extract fresh
		rmSync(vendorDir, { recursive: true, force: true })
		mkdirSync(vendorDir, { recursive: true })
		await extract({ file: tarballPath, cwd: vendorDir, strip: 1 })

		// Write version marker only after successful extraction
		writeFileSync(versionFile, SUPERPOWERS_VERSION)
	} finally {
		// Always clean up the temp tarball — whether download/extract succeeded or failed
		await unlink(tarballPath).catch(() => undefined)
	}

	return true
}
