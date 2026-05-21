import { basename } from "node:path"
import { readApiKeyFromConfigFile } from "../../../config.js"
import { findProxyHelper } from "../../../ssh-proxy.js"

/**
 * Builds an SSH ProxyCommand string for use with Teleport.
 *
 * When running as a compiled binary (i.e. not under `node` or `bun`), the
 * command delegates back to the current executable via `--ssh-proxy`.
 *
 * In dev mode (running under `node`/`bun`), falls back to locating the
 * standalone proxy helper script and injects the API key via the environment.
 */
export function buildProxyCommand(): string {
	const binaryName = basename(process.execPath)
	if (binaryName !== "bun" && binaryName !== "node") {
		return `${binaryName} --ssh-proxy %h`
	}

	// Fallback for when running in dev mode.

	const proxyHelper = findProxyHelper()
	const apiKey = process.env.KIMCHI_API_KEY ?? readApiKeyFromConfigFile()

	return `env KIMCHI_API_KEY=${apiKey} ${proxyHelper} ssh-proxy %h`
}
