import type * as ChildProcessModule from "node:child_process"
import { ChildProcess, spawn } from "node:child_process"
import { afterEach, expect, it, vi } from "vitest"
import { runInWorkspace } from "./worktree-launch.js"

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcessModule>()),
	spawn: vi.fn(),
}))
vi.mock("./utils/spawn-kimchi-subprocess.js", () => ({
	getAgentInvocation: (args: string[]) => ({ command: "/app/kimchi", args }),
}))
afterEach(() => vi.clearAllMocks())

it("launches the harness in the selected directory with inherited terminal and explicit environment", async () => {
	const child = new ChildProcess()
	vi.mocked(spawn).mockReturnValue(child)
	const run = runInWorkspace("/repo.worktrees/fix", ["--model", "fake/test"], { HOME: "/isolated" })
	expect(spawn).toHaveBeenCalledWith("/app/kimchi", ["--model", "fake/test"], {
		cwd: "/repo.worktrees/fix",
		stdio: "inherit",
		env: { HOME: "/isolated" },
	})
	child.emit("exit", 7, null)
	expect(await run).toBe(7)
})

it("forwards termination to its child and removes its signal handlers on exit", async () => {
	const child = new ChildProcess()
	vi.mocked(spawn).mockReturnValue(child)
	const kill = vi.spyOn(child, "kill").mockReturnValue(true)
	const before = process.listeners("SIGTERM")
	const run = runInWorkspace("/repo", [])
	const added = process.listeners("SIGTERM").filter((handler) => !before.includes(handler))
	expect(added).toHaveLength(1)
	added[0]("SIGTERM")
	expect(kill).toHaveBeenCalledWith("SIGTERM")
	child.emit("exit", null, "SIGTERM")
	expect(await run).toBe(143)
	expect(process.listeners("SIGTERM")).toEqual(before)
})

it("cleans up after a spawn error without reporting success", async () => {
	const child = new ChildProcess()
	vi.mocked(spawn).mockReturnValue(child)
	const before = process.listeners("SIGHUP")
	const run = runInWorkspace("/repo", [])
	child.emit("error", new Error("ENOENT"))
	await expect(run).rejects.toThrow("ENOENT")
	expect(process.listeners("SIGHUP")).toEqual(before)
})
