import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getMetadataCachePath } from "pi-mcp-adapter/metadata-cache"
import { afterEach, describe, expect, it, vi } from "vitest"

const fsState = vi.hoisted(() => ({ failWith: undefined as Error | undefined }))

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>()
	return {
		...original,
		statSync: ((...args: Parameters<typeof original.statSync>) => {
			if (fsState.failWith !== undefined) throw fsState.failWith
			return original.statSync(...args)
		}) as typeof original.statSync,
	}
})

import { sameCacheFileStamp, statMetadataCacheFile } from "./cache-file-stamp.js"

function writeCache(contents: string, viaRename: boolean): void {
	const path = getMetadataCachePath()
	mkdirSync(join(path, ".."), { recursive: true })
	if (!viaRename) {
		writeFileSync(path, contents)
		return
	}
	const tmp = `${path}.tmp`
	writeFileSync(tmp, contents)
	renameSync(tmp, path)
}

describe("statMetadataCacheFile", () => {
	afterEach(() => {
		fsState.failWith = undefined
	})

	it("returns the missing-file stamp when the cache file does not exist", () => {
		expect(statMetadataCacheFile()).toEqual({ dev: 0n, ino: 0n, size: -1n, mtimeNs: 0n, ctimeNs: 0n })
	})

	it("changes the stamp when the adapter rewrites the file", () => {
		writeCache('{"version":1,"servers":{}}', false)
		const before = statMetadataCacheFile()
		writeCache('{"version":1,"servers":{"a":1}}', true)
		const after = statMetadataCacheFile()
		if (before === null || after === null) throw new Error("stat failed")
		expect(sameCacheFileStamp(before, after)).toBe(false)
	})

	it("returns null when stat fails", () => {
		fsState.failWith = Object.assign(new Error("denied"), { code: "EACCES" })
		expect(statMetadataCacheFile()).toBeNull()
	})
})
