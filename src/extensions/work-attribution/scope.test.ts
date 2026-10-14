import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import * as organizations from "../../api/organizations.js"
import * as config from "../../config.js"
import { captureWorkAccount, workRepository } from "./scope.js"

const ORG = "30000000-0000-4000-8000-000000000003"
const USER = "40000000-0000-4000-8000-000000000004"
const OTHER_USER = "50000000-0000-4000-8000-000000000005"
let root: string
let key: string

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-work-scope-cache-")))
	key = randomUUID()
	const original = config.loadConfig()
	const endpoints = config.resolveEndpoints()
	vi.spyOn(config, "loadConfig").mockImplementation(() => ({ ...original, apiKey: key }))
	vi.spyOn(config, "resolveEndpoints").mockImplementation(() => ({
		...endpoints,
		platformApiUrl: "https://account.example/api",
	}))
	// No test reaches the network: an unexpected check fails like an offline one.
	vi.spyOn(organizations, "verifyApiKey").mockRejectedValue(new Error("offline"))
	vi.useFakeTimers({ toFake: ["Date"] })
})
afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	rmSync(root, { recursive: true, force: true })
})

it("asks Git once per working folder for a while", async () => {
	const cwd = join(root, "repo")
	execFileSync("git", ["init", "-q", cwd])
	const repository = await workRepository(cwd)
	rmSync(join(cwd, ".git"), { recursive: true })
	// Within the window the folder keeps its repository without another Git process.
	expect(await workRepository(cwd)).toBe(repository)
	vi.advanceTimersByTime(30_000)
	await expect(workRepository(cwd)).rejects.toThrow()
})

it("keeps answering with the verified identity while a refresh runs after a minute", async () => {
	const verify = vi.mocked(organizations.verifyApiKey).mockResolvedValueOnce({ organizationId: ORG, userId: USER })
	expect((await captureWorkAccount(root))?.account.userId).toBe(USER)
	vi.advanceTimersByTime(60_000)
	verify.mockImplementationOnce(
		() => new Promise((resolve) => setTimeout(() => resolve({ organizationId: ORG, userId: OTHER_USER }), 50)),
	)
	// The expired identity answers at once; the refresh runs in the background.
	expect((await captureWorkAccount(root))?.account.userId).toBe(USER)
	expect(verify).toHaveBeenCalledTimes(2)
	await vi.waitFor(async () => expect((await captureWorkAccount(root))?.account.userId).toBe(OTHER_USER))
	expect(verify).toHaveBeenCalledTimes(2)
})

it("forgets the identity when its refresh fails", async () => {
	const verify = vi.mocked(organizations.verifyApiKey).mockResolvedValueOnce({ organizationId: ORG, userId: USER })
	expect((await captureWorkAccount(root))?.account.userId).toBe(USER)
	vi.advanceTimersByTime(60_000)
	verify.mockRejectedValueOnce(new Error("key revoked"))
	expect((await captureWorkAccount(root))?.account.userId).toBe(USER)
	await vi.waitFor(async () => expect(await captureWorkAccount(root)).toBeUndefined())
	expect(verify).toHaveBeenCalledTimes(3)
})

it("never answers another key with a verified identity", async () => {
	const verify = vi
		.mocked(organizations.verifyApiKey)
		.mockResolvedValueOnce({ organizationId: ORG, userId: USER })
		.mockResolvedValueOnce({ organizationId: ORG, userId: OTHER_USER })
	expect((await captureWorkAccount(root))?.account.userId).toBe(USER)
	key = randomUUID()
	expect((await captureWorkAccount(root))?.account.userId).toBe(OTHER_USER)
	expect(verify).toHaveBeenLastCalledWith(key, expect.objectContaining({ endpoint: "https://account.example/api" }))
})
