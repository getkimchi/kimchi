import { describe, expect, it } from "vitest"
import config from "../vitest.config.js"

describe("Vitest configuration", () => {
	it("excludes generated TUI test caches at every depth", () => {
		expect(config).toMatchObject({
			test: { exclude: expect.arrayContaining(["**/.tui-test/**"]) },
		})
	})
})
