import { chmod, lstat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { checkReviewDirectory } from "../review-submit/directory-safety.js"

export interface ReviewSessionFile {
	sessionFile: string
	sessionDir: string
}

async function checkedDirectory(path: string): Promise<string> {
	const checked = await checkReviewDirectory(path, { isDefault: false, create: true })
	if (checked.kind !== "ready") throw new Error(`Review session directory ${path} is unavailable or unsafe.`)
	return checked.path
}

export class ReviewSessionStore {
	private readonly nextSuffix = new Map<string, number>()

	private constructor(readonly directory: string) {}

	static async create(outputDir: string): Promise<ReviewSessionStore> {
		const output = await checkedDirectory(resolve(outputDir))
		const directory = await checkedDirectory(join(output, "sessions"))
		await chmod(directory, 0o700)
		return new ReviewSessionStore(directory)
	}

	async allocate(writer: string): Promise<ReviewSessionFile> {
		let suffix = this.nextSuffix.get(writer) ?? 1
		while (true) {
			const filename = suffix === 1 ? `${writer}.jsonl` : `${writer}.${suffix}.jsonl`
			const sessionFile = join(this.directory, filename)
			suffix += 1
			try {
				await lstat(sessionFile)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				this.nextSuffix.set(writer, suffix)
				return { sessionFile, sessionDir: this.directory }
			}
		}
	}

	async makePrivate(sessionFile: string): Promise<void> {
		try {
			const metadata = await lstat(sessionFile)
			if (!metadata.isFile() || metadata.isSymbolicLink()) {
				throw new Error(`Review session ${sessionFile} is not a regular file.`)
			}
			await chmod(sessionFile, 0o600)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return
			throw error
		}
	}
}
