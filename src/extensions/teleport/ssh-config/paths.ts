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
	// Profile-scoped: the managed ssh_config lives under the active profile's
	// root (default profile: ~/.config/kimchi), so named profiles keep a fully
	// separated ssh setup. The XDG fallback preserves the pre-profile location
	// for standalone imports that never resolved a profile.
	const xdgConfigHome =
		env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(home, ".config")
	const managedDir = env.KIMCHI_PROFILE_ROOT ?? join(xdgConfigHome, "kimchi")
	const sshDir = join(home, ".ssh")
	return {
		managedDir,
		managedFile: join(managedDir, "ssh_config"),
		sshDir,
		userConfigFile: join(sshDir, "config"),
	}
}
