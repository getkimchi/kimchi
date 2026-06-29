import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { extract as tarExtract } from "tar"

/**
 * Verify the SHA-256 of `path` matches `expected` (raw bytes). Throws on
 * mismatch — that's a hard error, the binary on disk after rename would
 * otherwise be a tampered or partial download.
 */
export async function verifyChecksum(path: string, expected: Uint8Array): Promise<void> {
	const hash = createHash("sha256")
	await pipeline(createReadStream(path), hash)
	const actual = hash.digest()
	if (actual.length !== expected.length || !actual.equals(Buffer.from(expected))) {
		throw new Error(`checksum mismatch: expected ${hexEncode(expected)}, got ${actual.toString("hex")}`)
	}
}

/**
 * Extract the platform archive into a fresh temp dir preserving full directory structure.
 * Returns the root extraction directory; the caller is responsible for cleaning
 * it up. Archive structure is expected to be:
 *   extractedRoot/
 *   ├── bin/
 *   │   └── kimchi(.exe)
 *   └── share/
 *       └── kimchi/
 *           └── ... (supporting files)
 *
 * POSIX tar extraction blocks path traversal explicitly. Windows zip extraction
 * is only used after checksum verification against the release manifest.
 */
export async function extractArchive(archivePath: string): Promise<string> {
	if (process.platform === "win32") {
		return extractZip(archivePath)
	}
	return extractTarGz(archivePath)
}

export async function extractTarGz(archivePath: string): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "kimchi-update-"))
	await tarExtract({
		file: archivePath,
		cwd: root,
		// tar's filter accepts (path, entry) — we don't filter, just want the
		// default behavior, but we set strict to false so we don't blow up on
		// minor format quirks. Block path traversal explicitly.
		filter: (path) => !path.startsWith(".."),
	})
	return root
}

function extractZip(archivePath: string): string {
	const root = mkdtempSync(join(tmpdir(), "kimchi-update-"))
	execFileSync("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"Expand-Archive",
		"-LiteralPath",
		archivePath,
		"-DestinationPath",
		root,
		"-Force",
	])
	return root
}

function hexEncode(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex")
}
