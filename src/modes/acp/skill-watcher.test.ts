import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../project-scope-trust.js"
import { createSkillWatcher } from "./skill-watcher.js"
import { waitFor } from "./test-utils.js"

const dirs: string[] = []

beforeEach(() => {
	// Hermetic home: the resolver defaults to os.homedir() (reads $HOME), so
	// without this the test watcher also watches the developer's real harness
	// skills dir — a real kimchi instance writing there would kick mid-test.
	vi.stubEnv("HOME", makeTmp())
})

afterEach(() => {
	vi.unstubAllEnvs()
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	resetProjectScopeTrustForTests()
})

function makeTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "skill-watcher-"))
	dirs.push(dir)
	return dir
}

const waitForCalls = async (get: () => number, want: number, timeoutMs = 5000): Promise<void> =>
	waitFor(() => get() >= want, {
		timeoutMs,
		message: () => `waitForCalls: got ${get()}, wanted ${want}`,
	})

function writeSkill(dir: string, name: string): void {
	mkdirSync(join(dir, name), { recursive: true })
	writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\nbody`, "utf-8")
}

// Probe-based settle: write a throwaway skill into a watched root and wait
// for the kick — proof the watch is live; chokidar's ignored initial-scan
// window duration is unknown, so wall-clock sleeps flake (loaded CI).
async function settleWatch(agentDir: string, calls: number[]): Promise<number> {
	const base = calls.length
	writeSkill(join(agentDir, "skills"), "__probe__")
	await waitForCalls(() => calls.length, base + 1)
	return calls.length
}

describe("createSkillWatcher", () => {
	it("requests a refresh for skill add and delete in a watched root", async () => {
		const agentDir = makeTmp()
		const cwd = makeTmp()
		setProjectScopeTrusted(cwd, true)
		const calls: number[] = []
		const watcher = createSkillWatcher({ agentDir, requestRefresh: () => calls.push(1) })
		try {
			watcher.addSession({ cwd })
			const base = await settleWatch(agentDir, calls)

			writeSkill(join(agentDir, "skills"), "first")
			await waitForCalls(() => calls.length, base + 1)

			rmSync(join(agentDir, "skills", "first"), { recursive: true, force: true })
			await waitForCalls(() => calls.length, base + 2)
		} finally {
			watcher.close()
		}
	})

	it("coalesces a burst of changes into one refresh kick", async () => {
		const agentDir = makeTmp()
		const cwd = makeTmp()
		setProjectScopeTrusted(cwd, true)
		const calls: number[] = []
		const watcher = createSkillWatcher({ agentDir, requestRefresh: () => calls.push(1) })
		try {
			watcher.addSession({ cwd })
			const base = await settleWatch(agentDir, calls)
			// A multi-skill upload fires many events within the debounce window.
			for (const name of ["a", "b", "c", "d"]) writeSkill(join(agentDir, "skills"), name)
			await waitForCalls(() => calls.length, base + 1)
			await delay(400)
			expect(calls.length).toBe(base + 1)
		} finally {
			watcher.close()
		}
	})

	it("does not refresh on changes outside watched roots", async () => {
		const agentDir = makeTmp()
		const cwd = makeTmp()
		setProjectScopeTrusted(cwd, true)
		const calls: number[] = []
		const watcher = createSkillWatcher({ agentDir, requestRefresh: () => calls.push(1) })
		try {
			watcher.addSession({ cwd })
			const base = await settleWatch(agentDir, calls)
			writeFileSync(join(cwd, "README.md"), "not a skill", "utf-8")
			writeSkill(join(cwd, "unwatched-skills"), "nope")
			await delay(500)
			expect(calls.length).toBe(base)
		} finally {
			watcher.close()
		}
	})

	it("removeSession keeps watching while another session shares the cwd", async () => {
		const agentDir = makeTmp()
		const cwd = makeTmp()
		setProjectScopeTrusted(cwd, true)
		const calls: number[] = []
		const watcher = createSkillWatcher({ agentDir, requestRefresh: () => calls.push(1) })
		try {
			watcher.addSession({ cwd })
			watcher.addSession({ cwd })
			watcher.removeSession({ cwd })
			const base = await settleWatch(agentDir, calls)
			writeSkill(join(agentDir, "skills"), "still-watching")
			await waitForCalls(() => calls.length, base + 1)
		} finally {
			watcher.close()
		}
	})

	it("ignores addSession after close()", async () => {
		const agentDir = makeTmp()
		const cwd = makeTmp()
		setProjectScopeTrusted(cwd, true)
		const calls: number[] = []
		const watcher = createSkillWatcher({ agentDir, requestRefresh: () => calls.push(1) })

		watcher.addSession({ cwd })
		await settleWatch(agentDir, calls)
		const settled = calls.length

		watcher.close()
		watcher.addSession({ cwd })
		writeSkill(join(agentDir, "skills"), "zombie")
		await delay(500)

		expect(calls.length).toBe(settled)
	})
})
