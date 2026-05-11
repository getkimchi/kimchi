# Kimchi JetBrains Plugin

IDE integration plugin that turns JetBrains IDEs into an MCP server for the Kimchi CLI.

## How it works

The plugin starts a WebSocket server (MCP server) when a project opens. The Kimchi CLI acts as the MCP client:

1. Plugin starts a WebSocket server on a random localhost port
2. Plugin writes `~/.config/kimchi/ide/<port>.lock` with the port, auth token, and workspace folders
3. Kimchi CLI scans that directory on startup, finds the matching lockfile, and connects
4. Plugin sends `selection_changed` notifications as you move the cursor
5. "Send to Kimchi" action sends an `at_mentioned` notification — Kimchi prepends `@/path/to/file:start-end` to your next prompt so Claude reads that section automatically

## Requirements

- JDK 17+
- IntelliJ IDEA 2023.2+ (or any other JetBrains IDE of the same generation)
- Gradle (the wrapper `./gradlew` is included)

## Build

```bash
cd plugins/jetbrains

# Compile only
./gradlew compileKotlin

# Build the plugin zip (output: build/distributions/*.zip)
./gradlew buildPlugin
```

## Run in a sandboxed IDE

This launches a fresh IntelliJ instance with the plugin installed — no need to install anything manually:

```bash
./gradlew runIde
```

The sandbox IDE opens with a clean profile. Open a project, start Kimchi in its integrated terminal, and the plugin connects automatically.

## Install in your own IDE

1. Build the plugin zip:
   ```bash
   ./gradlew buildPlugin
   ```
2. In your IDE go to **Settings → Plugins → ⚙ → Install Plugin from Disk…**
3. Select `build/distributions/jetbrains-1.0.0.zip`
4. Restart the IDE

## Test the integration end-to-end

1. Build and install the plugin (or use `./gradlew runIde`)
2. Open a project in the IDE
3. Start Kimchi in the IDE's integrated terminal:
   ```bash
   kimchi
   ```
   You should see `[kimchi] IDE plugin connected - context sharing enabled` in the output.
4. Select some code in the editor and press **Ctrl+Shift+K** (or right-click → **Send to Kimchi**)
5. Type a prompt in the Kimchi terminal — the selected file and line range are prepended automatically as `@/abs/path/to/file:start-end`

## Verify the lockfile

After opening a project with the plugin active, confirm the lockfile was created:

```bash
ls ~/.config/kimchi/ide/
cat ~/.config/kimchi/ide/*.lock
```

Expected content:
```json
{
  "port": 54321,
  "authToken": "uuid-here",
  "ideName": "IntelliJ IDEA",
  "ideVersion": "2024.1",
  "transport": "ws",
  "workspaceFolders": ["/path/to/your/project"],
  "pid": 12345
}
```

The lockfile is deleted automatically when the project closes.

## Useful Gradle tasks

| Task | Description |
|---|---|
| `./gradlew compileKotlin` | Compile Kotlin sources |
| `./gradlew buildPlugin` | Build distributable zip |
| `./gradlew runIde` | Launch sandboxed IDE with plugin loaded |
| `./gradlew verifyPlugin` | Validate plugin structure |
| `./gradlew listProductsReleases` | List compatible IDE versions |
