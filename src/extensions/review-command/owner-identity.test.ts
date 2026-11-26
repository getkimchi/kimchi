import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { reviewProcessStartIdentity } from "./owner-identity.js"

const temporaryDirectories: string[] = []

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("review process start identity", () => {
	it.skipIf(process.platform === "win32")("reads ps lstart output under the C locale", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-owner-locale-"))
		temporaryDirectories.push(root)
		const capture = join(root, "locale")
		const ps = join(root, "ps")
		writeFileSync(ps, '#!/bin/sh\nprintf "%s" "$LC_ALL" > "$PS_ENV_CAPTURE"\nprintf "Thu Nov 26 11:49:17 2026\\n"\n')
		chmodSync(ps, 0o700)
		vi.stubEnv("PATH", `${root}:${process.env.PATH ?? ""}`)
		vi.stubEnv("PS_ENV_CAPTURE", capture)
		vi.stubEnv("LC_ALL", "pl_PL.UTF-8")
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin")

		await expect(reviewProcessStartIdentity(process.pid)).resolves.toBe(String(Date.parse("Thu Nov 26 11:49:17 2026")))
		expect(readFileSync(capture, "utf8")).toBe("C")
	})
})
