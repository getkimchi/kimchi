import * as fs from "node:fs"
import { join } from "node:path"

interface LinkPluginInput {
	name: string
	sourceDir: string
	claudeHome: string
}

interface LinkResult {
	ok: true
	created: number
	replaced: number
	skipped: number
}

interface LinkError {
	ok: false
	reason: "exists-not-symlink" | "symlink-permission"
	path?: string
}

type LinkPluginResult = LinkResult | LinkError

interface UnlinkResult {
	ok: true
	removed: number
}

interface UnlinkError {
	ok: false
	reason: "exists-not-symlink"
	path?: string
}

type UnlinkPluginResult = UnlinkResult | UnlinkError

const DIRS = ["commands", "agents"] as const

export function linkPlugin(input: LinkPluginInput): LinkPluginResult {
	const { name, sourceDir, claudeHome } = input
	let created = 0
	let replaced = 0
	let skipped = 0

	for (const dir of DIRS) {
		const target = join(claudeHome, dir, name)
		const source = join(sourceDir, dir)

		let stat: ReturnType<typeof fs.lstatSync> | null = null
		try {
			stat = fs.lstatSync(target)
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
		}

		if (stat === null) {
			fs.mkdirSync(join(claudeHome, dir), { recursive: true })
			try {
				fs.symlinkSync(source, target, "dir")
			} catch (err: unknown) {
				const e = err as NodeJS.ErrnoException
				if (e.code === "EPERM") {
					return { ok: false, reason: "symlink-permission", path: target }
				}
				throw err
			}
			created++
		} else if (stat.isSymbolicLink()) {
			const current = fs.readlinkSync(target)
			if (current === source) {
				skipped++
			} else {
				fs.unlinkSync(target)
				try {
					fs.symlinkSync(source, target, "dir")
				} catch (err: unknown) {
					const e = err as NodeJS.ErrnoException
					if (e.code === "EPERM") {
						return { ok: false, reason: "symlink-permission", path: target }
					}
					throw err
				}
				replaced++
			}
		} else {
			return { ok: false, reason: "exists-not-symlink", path: target }
		}
	}

	return { ok: true, created, replaced, skipped }
}

export function unlinkPlugin(input: { name: string; claudeHome: string }): UnlinkPluginResult {
	const { name, claudeHome } = input
	let removed = 0

	for (const dir of DIRS) {
		const target = join(claudeHome, dir, name)

		let stat: ReturnType<typeof fs.lstatSync> | null = null
		try {
			stat = fs.lstatSync(target)
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
		}

		if (stat === null) {
			// not present, fine
		} else if (stat.isSymbolicLink()) {
			fs.unlinkSync(target)
			removed++
		} else {
			return { ok: false, reason: "exists-not-symlink", path: target }
		}
	}

	return { ok: true, removed }
}
