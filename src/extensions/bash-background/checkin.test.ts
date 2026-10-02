import { expect, it, vi } from "vitest"
import { awaitCheckin } from "./checkin.js"
import { createProcessRegistry } from "./process-registry.js"

it("does not create display snapshots without an update consumer", async () => {
	const registry = createProcessRegistry()
	const handle = registry.spawn({ exec: async () => ({ exitCode: 0 }) }, "true", "/tmp", undefined, {
		intervalSeconds: 15,
		deadlineMs: Date.now() + 60_000,
	})
	const display = vi.spyOn(registry, "displaySnapshot")
	try {
		await expect(awaitCheckin(registry, handle, 15)).resolves.toMatchObject({ state: "exited", exitCode: 0 })
		expect(display).not.toHaveBeenCalled()
	} finally {
		await registry.shutdown()
	}
})
