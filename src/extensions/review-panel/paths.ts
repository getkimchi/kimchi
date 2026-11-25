import { realpath } from "node:fs/promises"

/** Compare path spellings by their filesystem targets; missing paths do not match. */
export async function sameFilesystemPath(left: string, right: string): Promise<boolean> {
	try {
		const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)])
		return realLeft === realRight
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}
