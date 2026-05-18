import { existsSync } from "node:fs"
import { join } from "node:path"

let cached: string | undefined

/**
 * Resolve the on-disk path to `teleport-proxy.js`.
 *
 * In dev mode (`bun src/entry.ts`), `new URL("./teleport-proxy.js", import.meta.url)`
 * resolves to a real source file we can hand directly to ssh's ProxyCommand.
 *
 * In a `bun build --compile` binary the same URL points into bun's embedded
 * virtual filesystem (`/$bunfs/...`) which is invisible to an external `node`
 * — and we've confirmed it's also unreadable via our own `fs.readFileSync`.
 * So at build time `scripts/copy-resources.js` copies the proxy into
 * `dist/share/kimchi/teleport-proxy.js`, and at startup `src/entry.ts` pins
 * `PI_PACKAGE_DIR` to that share dir via `resolveAuxiliaryFilesDir`.
 *
 * Cached for the lifetime of the process.
 */
export function getTeleportProxyPath(): string {
	if (cached && existsSync(cached)) return cached

	const internal = new URL("./teleport-proxy.js", import.meta.url).pathname
	if (!internal.includes("$bunfs") && existsSync(internal)) {
		cached = internal
		return internal
	}

	const pkgDir = process.env.PI_PACKAGE_DIR
	if (pkgDir) {
		const sharePath = join(pkgDir, "teleport-proxy.js")
		if (existsSync(sharePath)) {
			cached = sharePath
			return sharePath
		}
	}

	throw new Error(
		"Could not locate teleport-proxy.js. Run `pnpm run build:binary` " +
			"(and `pnpm run install:local` for system-wide use), or set PI_PACKAGE_DIR " +
			"to a directory containing teleport-proxy.js.",
	)
}
