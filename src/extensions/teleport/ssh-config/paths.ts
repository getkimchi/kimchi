import { homedir } from "node:os"
import { join } from "node:path"

export interface SshConfigPaths {
	/** The managed file we own and rewrite from the workspace list. */
	managedFile: string
	/** The user's main ssh config, where we add an `Include` directive. */
	userConfigFile: string
	/** Directory for the managed file. */
	managedDir: string
	/** Directory for the user's ssh config. */
	sshDir: string
}

export function resolveSshConfigPaths(env: NodeJS.ProcessEnv = process.env): SshConfigPaths {
	const home = env.HOME || homedir()
	const xdgConfigHome =
		env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(home, ".config")
	const managedDir = join(xdgConfigHome, "kimchi")
	const sshDir = join(home, ".ssh")
	return {
		managedDir,
		managedFile: join(managedDir, "ssh_config"),
		sshDir,
		userConfigFile: join(sshDir, "config"),
	}
}
