import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import memoryExtension from "./index.js"

describe("memoryExtension", () => {
	let tmpDir: string
	let pi: {
		registerTool: ReturnType<typeof vi.fn>
		on: ReturnType<typeof vi.fn>
		getActiveTools: ReturnType<typeof vi.fn>
		setActiveTools: ReturnType<typeof vi.fn>
	}
	let ctx: { cwd: string; memorySnapshot?: { memory: string | null; user: string | null } | undefined }

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-memory-test-"))
		pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			getActiveTools: vi.fn().mockReturnValue([]),
			setActiveTools: vi.fn(),
		}
		ctx = { cwd: "/tmp" }
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("registers the memory tool", () => {
		memoryExtension(pi as unknown as Parameters<typeof memoryExtension>[0], { memoryDir: tmpDir })
		expect(pi.registerTool).toHaveBeenCalled()
		const call = pi.registerTool.mock.calls[0][0]
		expect(call.name).toBe("memory")
	})

	it("captures snapshot on session start", async () => {
		memoryExtension(pi as unknown as Parameters<typeof memoryExtension>[0], { memoryDir: tmpDir })
		const sessionStartHandler = pi.on.mock.calls.find((c: unknown[]) => c[0] === "session_start")?.[1]
		expect(sessionStartHandler).toBeDefined()
		await sessionStartHandler({} as never, ctx)
		expect(ctx.memorySnapshot).toBeDefined()
	})
})
