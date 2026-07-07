/**
 * Errors thrown from a main-process ipcMain.handle() come back to the
 * renderer wrapped by Electron itself, e.g.:
 *
 *   "Error invoking remote method 'kimchi:setup': Error: ACP connection
 *   closed. This usually means the configured API key is missing or
 *   invalid. ..."
 *
 * That "Error invoking remote method '<channel>': Error:" prefix is
 * Electron's own boilerplate, not anything we wrote — it's the reason a
 * failed Save in SetupPage/Settings has looked messier than the same
 * message shown in ChatWindow's status banner (which arrives via a plain
 * webContents.send() push, so it never gets wrapped in the first place).
 *
 * Strip it so every surface shows the same clean message the main process
 * actually authored.
 */
export function cleanIpcErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);

    const match = raw.match(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/);

    return (match ? match[1] : raw).trim();
}
