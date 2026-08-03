import { defineConfig } from "vitest/config"

/**
 * Mirrors kimchi-workflows/vitest.config.ts, minimal: this directory tests workflow DEFINITIONS, not
 * an engine, so there is no integration-test split here. `exclude` matters more than usual — `npm
 * install` symlinks `node_modules/@kimchi-dev/kimchi-workflows` straight at the sibling checkout (see
 * README.md), and that checkout has its own `test/**` tree; without excluding node_modules, a bare glob
 * could wander into it and run the engine's suite as if it were this package's own.
 */
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: ["**/node_modules/**"],
	},
})
