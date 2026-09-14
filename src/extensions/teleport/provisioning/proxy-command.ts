import { basename } from "node:path"
import { quote } from "shell-quote"
import { getAgentInvocation } from "../../../utils/spawn-kimchi-subprocess.js"

/**
 * Builds an SSH ProxyCommand string for use with Teleport.
 *
 * When running as a compiled binary (i.e. not under `node` or `bun`), the
 * command delegates back to the current executable via `--ssh-proxy`.
 *
 * In dev mode (running under `node`/`bun`), invokes Kimchi through its runtime.
 * The proxy entry point resolves the inherited API key or saved configuration.
 * Keep credentials out of this string: it is also persisted in SSH config.
 *
 * When `target` is "%h" (default), the proxy-helper receives the SSH host name
 * at connect time and resolves it via the listing endpoint. When `target` is a
 * literal session id, the helper takes the fast direct-fetch path.
 */
export function buildProxyCommand(target = "%h"): string {
	const binaryName = basename(process.execPath)
	if (binaryName !== "bun" && binaryName !== "node") {
		return `${binaryName} --ssh-proxy ${target}`
	}

	const invocation = getAgentInvocation(["--ssh-proxy", target])
	return quote([invocation.command, ...invocation.args])
}
