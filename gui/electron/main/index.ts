import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import fs from "node:fs";
import os from "node:os";
import { writeApiKey } from "../../../src/config";

let mainWindow: BrowserWindow | null = null;

// --- Kimchi process / ACP connection state -------------------------------

let kimchiProcess: ChildProcessWithoutNullStreams | null = null;
let conn: acp.ClientSideConnection | null = null;
let sessionId: string | null = null;

// While startKimchi() is verifying the API key against Kimchi's servers, it
// routes through a disposable session (never used for real chat) so that a
// validation exchange never ends up polluting the real conversation's
// context. sessionUpdate() checks this to decide whether to forward chunks
// to the renderer (never, for validation traffic) and to capture the
// validation response text (to sniff for auth-failure phrasing even when the
// call doesn't throw an outright exception).
let validationSessionId: string | null = null;
let validationResponseText = "";

let currentStatus = {
    state: "connecting" as "connecting" | "ready" | "error",
    message: undefined as string | undefined,
};

// Kimchi's own config file (per Kimchi CLI docs: ~/.config/kimchi/config.json).
// This is the file writeApiKey() creates/updates on setup, so checking for it
// (rather than just the containing directory) is what actually tells us
// whether an API key is configured — the directory can still exist for other
// reasons (tags.json, skills, etc.) even after the key itself is removed.
const CONFIG_DIR = path.join(os.homedir(), ".config", "kimchi");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const HARNESS_DIR = path.join(os.homedir(), ".config", "kimchi", "harness");
const MODELS_FILE = path.join(HARNESS_DIR, "models.json");
const SETTINGS_FILE = path.join(HARNESS_DIR, "settings.json");

interface KimchiModel {

    provider: string;

    id: string;

    name: string;

    reasoning: boolean;

    input: string[];

    contextWindow: number;

    maxTokens: number;

}

interface KimchiProvider {

    models: KimchiModel[];

}

// Override with env vars if you're running a built binary instead of bun+src.
// e.g. KIMCHI_BIN="C:\Users\you\.bun\bin\bun.exe" KIMCHI_BIN_ARGS="run --preload ./src/set-package-dir.ts src/entry.ts"
const KIMCHI_BIN = process.env.KIMCHI_BIN ?? // Only for packaged
    (
        app.isPackaged
            ? path.join(process.resourcesPath, "bin", process.platform === "win32" ? "kimchi.exe" : "kimchi")
            : "bun"
    );

const KIMCHI_ARGS = process.env.KIMCHI_BIN_ARGS // Only for development
    ? process.env.KIMCHI_BIN_ARGS.split(" ")
    : (
        app.isPackaged
            ? ["--mode", "acp"]
            : [
                "run",
                "--preload",
                "./src/set-package-dir.ts",
                "src/entry.ts",
                "--mode",
                "acp"
            ]
    );

// .cmd/.bat launchers require the shell on Windows; a real .exe (e.g. a
// direct path to bun.exe) does not, and skipping shell:true there avoids an
// extra cmd.exe hop in the stdio chain.
const NEEDS_SHELL = process.platform === "win32" && /\.(cmd|bat)$/i.test(KIMCHI_BIN);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for: ${label}`)), ms)
        ),
    ]);
}

// The GUI acts as the ACP *client*; kimchi (spawned with --mode acp) is the *agent*.
// This object implements the client-side callback surface the SDK expects
// (see scripts/verify-acp.mjs for the reference shape).
class GuiAcpClient {
    async sessionUpdate(params: acp.SessionNotification) {
        const update = params.update;

        // Validation traffic (the "is this API key actually good?" probe)
        // never reaches the chat UI — just capture the text so startKimchi()
        // can check it for auth-failure phrasing.
        if (params.sessionId === validationSessionId) {
            if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
                validationResponseText += update.content.text;
            }
            return;
        }

        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
            mainWindow?.webContents.send("chat:chunk", {
                sessionId: params.sessionId,
                text: update.content.text,
            });
        } else if (update.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") {
            mainWindow?.webContents.send("chat:thought", {
                sessionId: params.sessionId,
                text: update.content.text,
            });
        }
        // Tool call activity is still ignored for now (params.update.sessionUpdate === "tool_call" / "tool_call_update").
    }

    async requestPermission(params: acp.RequestPermissionRequest) {
        // Auto-deny for now — no permission UI yet. Revisit once tool-call
        // display / approval UX is built.
        const reject = params.options.find((o) => o.kind === "reject_once") ?? params.options[0];
        return { outcome: { outcome: "selected" as const, optionId: reject.optionId } };
    }

    async writeTextFile() {
        return {};
    }

    async readTextFile() {
        return { content: "" };
    }
}

async function startKimchi() {

    const packageDir = app.isPackaged
        ? path.join(process.resourcesPath, "share", "kimchi")
        : undefined;

    kimchiProcess = spawn(KIMCHI_BIN, KIMCHI_ARGS, {
        cwd: app.isPackaged
            ? process.resourcesPath
            : process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: NEEDS_SHELL,
        env: {
            ...process.env,
            ...(packageDir ? { PI_PACKAGE_DIR: packageDir } : {}),
        },
    });

    // Keep the last chunk of stderr around so a startup failure can explain
    // itself (e.g. missing API key / auth not configured yet) instead of
    // just saying "not connected".
    let stderrTail = "";
    const proc = kimchiProcess;

    const onStderrData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        process.stderr.write(text); // still show it live in this terminal
        stderrTail = (stderrTail + text).slice(-4000);
    };
    proc.stderr?.on("data", onStderrData);

    const onError = (err: Error) => {
        console.error("Failed to spawn kimchi:", err);
    };
    proc.once("error", onError);

    let exitedEarly: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {

        // Only tear down module-level state / notify the renderer if this
        // exited process is still the one we're tracking — an old process
        // from a prior reconnect can still fire this handler after being
        // superseded, and we don't want it clobbering a newer connection.
        const wasActiveProcess = kimchiProcess === proc;

        if (!sessionId) {
            // Died before we ever got a working session — startKimchi()'s
            // catch block will read exitedEarly/stderrTail to explain why.
            exitedEarly = { code, signal };
        } else if (wasActiveProcess) {
            // The process died mid-session (after having been ready) —
            // let the renderer know instead of leaving a stale "ready" status.
            currentStatus = {
                state: "error",
                message: "Kimchi process exited unexpectedly.",
            };
            mainWindow?.webContents.send("kimchi:status", currentStatus);
        }

        proc.stderr?.removeListener("data", onStderrData);
        proc.removeListener("error", onError);

        if (wasActiveProcess) {
            conn = null;
            sessionId = null;
            kimchiProcess = null;
            validationSessionId = null;
        }
    };
    proc.once("exit", onExit);

    const writable = Writable.toWeb(kimchiProcess.stdin);
    const readable = Readable.toWeb(kimchiProcess.stdout);
    const stream = acp.ndJsonStream(writable, readable);

    conn = new acp.ClientSideConnection(() => new GuiAcpClient(), stream);

    try {

        // Reassign the module-level status (not a local shadow) so
        // kimchi:getStatus always reflects reality.
        currentStatus = {
            state: "connecting",
            message: undefined
        };

        mainWindow?.webContents.send("kimchi:status", currentStatus);
        const init = await withTimeout(
            conn.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            }),
            20_000,
            "ACP initialize"
        );

        if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
            throw new Error(
                `ACP protocol mismatch: kimchi speaks ${init.protocolVersion}, GUI expects ${acp.PROTOCOL_VERSION}`
            );
        }

        // The ACP initialize/newSession handshake above is entirely local —
        // it just confirms the kimchi *process* speaks the protocol. It
        // proves nothing about whether the configured API key is valid or
        // whether we can actually reach Kimchi's servers. So: open a
        // disposable session and send one small prompt through it. This is
        // a real network round-trip — a bad key or no internet will surface
        // here (as a thrown error, a timeout, or an error-flavored reply),
        // and only a genuinely successful reply earns "ready".
        const validation = await withTimeout(
            conn.newSession({ cwd: process.cwd(), mcpServers: [] }),
            20_000,
            "ACP newSession (validation)"
        );
        validationSessionId = validation.sessionId;
        validationResponseText = "";

        await withTimeout(
            conn.prompt({
                sessionId: validationSessionId,
                prompt: [{ type: "text", text: "Reply with just: OK" }],
            }),
            25_000,
            "API key verification"
        );

        const looksLikeAuthFailure = /401|invalid[ _-]?api[ _-]?key|unauthorized|not authenticated/i
            .test(validationResponseText);

        validationSessionId = null;

        if (looksLikeAuthFailure) {
            throw new Error(
                `Kimchi's servers rejected the configured API key.\n\nResponse: ${validationResponseText.trim().slice(0, 300)}`
            );
        }

        const session = await withTimeout(
            conn.newSession({ cwd: process.cwd(), mcpServers: [] }),
            20_000,
            "ACP newSession"
        );
        sessionId = session.sessionId;
    } catch (err) {
        validationSessionId = null;

        // Kimchi intentionally skips its interactive setup wizard when stdin
        // isn't a real terminal (which is always true here), so a missing
        // API key/auth surfaces as a plain error + early exit instead of a
        // wizard prompt. Recognize that case and say so plainly.
        const looksLikeAuthIssue = /401|api[ _-]?key|unauthorized|not authenticated/i.test(
            stderrTail + validationResponseText
        );
        const hint = looksLikeAuthIssue
            ? "\n\nThis usually means the configured API key is missing or invalid. " +
              "Open Settings and re-enter a valid API key."
            : exitedEarly
            ? "\n\nThis usually means Kimchi hasn't been set up yet on this machine (no API key / auth configured). " +
              "Open a terminal in the project folder and run first-time setup there (it needs an interactive " +
              "terminal, which this GUI can't provide), e.g.:\n  bun run dev:setup\nThen restart this app."
            : "";
        const detail = stderrTail.trim() ? `\n\nLast output from kimchi:\n${stderrTail.trim()}` : "";

        // Don't leave a partially-started process running in the background —
        // the "exit" handler above will finish clearing kimchiProcess/conn/etc.
        if (kimchiProcess === proc) {
            proc.kill();
        }

        throw new Error(`${err instanceof Error ? err.message : String(err)}${hint}${detail}`);
    }

    currentStatus = {
        state: "ready",
        message: undefined
    };

    mainWindow?.webContents.send("kimchi:status", currentStatus);
}

// --- Window ----------------------------------------------------------------

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,

        // Matches the splash background in index.html so there's no white
        // flash while the window is being created/painted for the first time.
        backgroundColor: "#f6f7fb",

        // Don't paint the window until the renderer has produced its first
        // frame (the static splash markup). Without this, Electron shows an
        // empty native window immediately, then the splash pops in a beat
        // later — that gap is the "blank window" the user is seeing.
        show: false,

        webPreferences: {
            preload: path.join(import.meta.dirname, "../preload/index.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });

    mainWindow.once("ready-to-show", () => {
        mainWindow?.show();
    });

    if (app.isPackaged) {
        mainWindow.loadFile(
            path.join(import.meta.dirname, "../../../out/renderer/index.html")
        );
    } else {
        mainWindow.loadURL("http://localhost:5173");
    }

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

ipcMain.handle("kimchi:getStatus", () => {
    return currentStatus;
});

ipcMain.handle("kimchi:getModels", () => {

    try {

        if (!fs.existsSync(MODELS_FILE)) {

            return [];

        }

        const json = JSON.parse(
            fs.readFileSync(MODELS_FILE, "utf8")
        );

        const providers = json.providers ?? {};

        const models = Object.values(
            providers as Record<string, KimchiProvider>
        ).flatMap(provider => provider.models ?? []);

        return models.map(m => ({

            provider: m.provider,

            id: m.id,

            name: m.name,

            reasoning: m.reasoning,

            input: m.input,

            contextWindow: m.contextWindow,

            maxTokens: m.maxTokens

        }));

    } catch (err) {

        console.error(err);

        return [];

    }

});

ipcMain.handle("kimchi:getCurrentModel", () => {

    try {

        if (!fs.existsSync(SETTINGS_FILE)) {

            return null;

        }

        const settings = JSON.parse(
            fs.readFileSync(SETTINGS_FILE, "utf8")
        );

        return {

            provider: settings.defaultProvider,

            model: settings.defaultModel

        };

    } catch (err) {

        console.error(err);

        return null;

    }

});

ipcMain.handle(
    "kimchi:setCurrentModel", async (_event, modelId: string) => {

        const settings = JSON.parse(
            fs.readFileSync(SETTINGS_FILE, "utf8")
        );

        const parsed = JSON.parse(
            fs.readFileSync(MODELS_FILE, "utf8")
        );

        const allModels = Object.values(
            parsed.providers as Record<string, KimchiProvider>
        ).flatMap(provider => provider.models);

        const model = allModels.find(
            m => m.id === modelId
        );

        if (!model) {
            throw new Error(`Unknown model: ${modelId}`);
        }
        // settings.defaultProvider = model.provider;
        settings.defaultModel = model.id;
        
        fs.writeFileSync(
            SETTINGS_FILE,
            JSON.stringify(settings, null, 2)
        );

        queueMicrotask(() => {
            reconnectKimchi().catch(console.error);
        });

        return true;

    }
);

ipcMain.handle("kimchi:isConfigured", () => {
    return fs.existsSync(CONFIG_FILE);
});

ipcMain.handle("kimchi:deleteApiKey", () => {

    // Tear down any live session first — there's no point keeping a
    // connection open to a key we're about to remove.
    kimchiProcess?.kill();
    kimchiProcess = null;
    conn = null;
    sessionId = null;
    validationSessionId = null;
    currentStatus = { state: "connecting", message: undefined };

    if (fs.existsSync(CONFIG_FILE)) {
        fs.rmSync(CONFIG_FILE);
    }

    return true;

});

ipcMain.handle("chat:send", async (_event, message: string) => {

    if (!conn || !sessionId) {
        throw new Error("Kimchi is not connected yet.");
    }

    const result = await conn.prompt({
        sessionId,
        prompt: [
            {
                type: "text",
                text: message
            }
        ]
    });

    return result.stopReason;

});

async function reconnectKimchi() {

    if (kimchiProcess) {

        kimchiProcess.kill();

        kimchiProcess = null;

        conn = null;
        sessionId = null;
        validationSessionId = null;

        // Give the OS a moment to release the process.
        await new Promise(resolve => setTimeout(resolve, 1000));

    }

    currentStatus = {
        state: "connecting",
        message: undefined,
    };

    mainWindow?.webContents.send("kimchi:status", currentStatus);

    await startKimchi();

}

ipcMain.handle("kimchi:setup", async (_event, apiKey: string) => {

    try {

        writeApiKey(apiKey);

        await reconnectKimchi();

        return true;

    } catch (err) {

        // startKimchi() already crafted a clean, specific message (it just
        // doesn't update currentStatus itself). Do that here so every
        // surface — the Settings modal's own error text *and* ChatWindow's
        // status banner — reflects the same failure immediately, whether
        // this run came from first-time setup or a Settings re-save.

        currentStatus = {
            state: "error",
            message: err instanceof Error ? err.message : String(err),
        };

        mainWindow?.webContents.send("kimchi:status", currentStatus);

        throw err;

    }

});

app.whenReady().then(async () => {

    createWindow();

    if (!fs.existsSync(CONFIG_FILE)) {

        return;
    }

    try {

        await reconnectKimchi();

    } catch (err) {

        console.error("Failed to start kimchi ACP session:", err);

    currentStatus = {
        state: "error",
        message: err instanceof Error ? err.message : String(err),
    };

    mainWindow?.webContents.send("kimchi:status", currentStatus);

    }

});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on("before-quit", () => {
    kimchiProcess?.kill();
});
