import type { UiHostContext, UiResourceContent, UiResourceCsp } from "./types.js"

// Use locally bundled AppBridge to avoid CDN Zod bundling issues
const DEFAULT_APP_BRIDGE_MODULE_URL = "/app-bridge.bundle.js"

export interface HostHtmlTemplateInput {
	sessionToken: string
	serverName: string
	toolName: string
	toolArgs: Record<string, unknown>
	resource: UiResourceContent
	allowAttribute: string
	requireToolConsent: boolean
	cacheToolConsent: boolean
	hostContext?: UiHostContext
	appBridgeModuleUrl?: string
}

export function buildHostHtmlTemplate(input: HostHtmlTemplateInput): string {
	const cspContent = buildCspMetaContent(input.resource.meta.csp)
	const resourceHtml = applyCspMeta(input.resource.html, cspContent)
	const hostContext = input.hostContext ?? {}

	const sessionToken = safeInlineJSON(input.sessionToken)
	const toolArgs = safeInlineJSON(input.toolArgs)
	const _uiHtml = safeInlineJSON(resourceHtml)
	const serverName = safeInlineJSON(input.serverName)
	const toolName = safeInlineJSON(input.toolName)
	const hostContextJson = safeInlineJSON(hostContext)
	const allowAttribute = safeInlineJSON(input.allowAttribute)
	const requireToolConsent = safeInlineJSON(input.requireToolConsent)
	const cacheToolConsent = safeInlineJSON(input.cacheToolConsent)
	const moduleUrl = safeInlineJSON(input.appBridgeModuleUrl ?? DEFAULT_APP_BRIDGE_MODULE_URL)

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MCP UI - ${escapeHtml(input.serverName)} / ${escapeHtml(input.toolName)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f1115;
      --surface: #181c22;
      --text: #ecf0f5;
      --muted: #a9b2bf;
      --accent: #43c0ff;
      --border: rgba(255, 255, 255, 0.12);
      --good: #34d399;
      --warn: #fbbf24;
      --bad: #f87171;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f7fb;
        --surface: #ffffff;
        --text: #1d2939;
        --muted: #667085;
        --accent: #0ea5e9;
        --border: rgba(15, 23, 42, 0.14);
        --good: #059669;
        --warn: #b45309;
        --bad: #b91c1c;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    body { display: flex; flex-direction: column; min-height: 100vh; }
    header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .title { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
    .server { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; white-space: nowrap; }
    .tool { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; font-size: 11px; color: var(--muted); white-space: nowrap; }
    .controls { display: flex; gap: 8px; align-items: center; }
    .status { font-size: 12px; color: var(--muted); white-space: nowrap; }
    button { border: 1px solid var(--border); background: transparent; color: var(--text); border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
    button.primary { border-color: color-mix(in srgb, var(--good) 40%, var(--border) 60%); color: var(--good); }
    button.danger { border-color: color-mix(in srgb, var(--bad) 40%, var(--border) 60%); color: var(--bad); }
    button:hover { background: color-mix(in srgb, var(--surface) 75%, var(--accent) 25%); }
    main { flex: 1; min-height: 0; padding: 10px; display: flex; }
    iframe { width: 100%; height: 100%; border: 1px solid var(--border); border-radius: 10px; background: white; }
    .overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--bg) 90%, black 10%); display: none; align-items: center; justify-content: center; z-index: 2; }
    .overlay.visible { display: flex; }
    .panel { width: min(680px, calc(100vw - 40px)); background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
    .panel h2 { margin: 0 0 8px; font-size: 16px; }
    .panel p { margin: 0; color: var(--muted); line-height: 1.4; font-size: 14px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <div class="title">
      <span class="server">MCP · <span id="server-name"></span></span>
      <span class="tool" id="tool-name"></span>
      <span class="badge">Sandboxed</span>
    </div>
    <div class="controls">
      <span class="status" id="status">Loading UI...</span>
      <button class="primary" id="done-btn" title="Cmd/Ctrl+Enter">Done</button>
      <button class="danger" id="cancel-btn" title="Escape">Cancel</button>
    </div>
  </header>
  <main>
    <iframe id="mcp-app" referrerpolicy="no-referrer"></iframe>
  </main>
  <div class="overlay" id="error-overlay">
    <div class="panel">
      <h2>UI Error</h2>
      <p id="error-message"></p>
    </div>
  </div>
  <script type="module">
    import { AppBridge, PostMessageTransport } from ${moduleUrl};

    const SESSION_TOKEN = ${sessionToken};
    const SERVER_NAME = ${serverName};
    const TOOL_NAME = ${toolName};
    const TOOL_ARGS = ${toolArgs};
    const HOST_CONTEXT = ${hostContextJson};
    const ALLOW_ATTRIBUTE = ${allowAttribute};
    const REQUIRE_TOOL_CONSENT = ${requireToolConsent};
    const CACHE_TOOL_CONSENT = ${cacheToolConsent};
    const STREAM_CONTEXT_KEY = "pi-mcp-adapter/stream";
    const STREAM_PATCH_METHOD = "notifications/pi-mcp-adapter/ui-result-patch";

    const iframe = document.getElementById("mcp-app");
    const statusNode = document.getElementById("status");
    const doneBtn = document.getElementById("done-btn");
    const cancelBtn = document.getElementById("cancel-btn");
    const errorOverlay = document.getElementById("error-overlay");
    const errorMessage = document.getElementById("error-message");

    document.getElementById("server-name").textContent = SERVER_NAME;
    document.getElementById("tool-name").textContent = TOOL_NAME;

    const setStatus = (text, isError = false) => {
      statusNode.textContent = text;
      statusNode.style.color = isError ? "var(--bad)" : "var(--muted)";
    };

    const showError = (message) => {
      errorMessage.textContent = message;
      errorOverlay.classList.add("visible");
      setStatus("Error", true);
    };

    const post = async (endpoint, params) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: SESSION_TOKEN, params }),
      });

      const body = await response.json().catch(() => ({ ok: false, error: "Invalid JSON response" }));
      if (!response.ok || !body.ok) {
        const message = body.error || ("HTTP " + response.status);
        throw new Error(message);
      }
      return body.result ?? {};
    };

    let consentGranted = !REQUIRE_TOOL_CONSENT;
    const initialStreamContext = HOST_CONTEXT?.[STREAM_CONTEXT_KEY];
    const streamMode = initialStreamContext?.mode === "stream-first" ? "stream-first" : "eager";

    const bridge = new AppBridge(
      null,
      { name: "pi", version: "1.0.0" },
      { serverTools: {}, openLinks: {}, logging: {}, updateModelContext: {}, message: {} },
      { hostContext: HOST_CONTEXT }
    );

    bridge.oncalltool = async (params) => {
      if (!consentGranted) {
        const accepted = window.confirm("Allow this UI to call server tools for this session?");
        if (!accepted) {
          await post("/proxy/ui/consent", { approved: false }).catch(() => {});
          return {
            isError: true,
            content: [{ type: "text", text: "Tool call denied by user." }],
          };
        }
        await post("/proxy/ui/consent", { approved: true });
        if (CACHE_TOOL_CONSENT) {
          consentGranted = true;
        }
      }
      const result = await post("/proxy/tools/call", params);
      // Notify agent about the tool call
      await post("/proxy/ui/message", {
        type: "intent",
        intent: "call_tool",
        params: { tool: params.name, arguments: params.arguments, isError: result.isError }
      }).catch(() => {});
      return result;
    };

    bridge.onmessage = async (params) => post("/proxy/ui/message", params);
    bridge.onupdatemodelcontext = async (params) => post("/proxy/ui/context", params);
    
    // Also listen for raw postMessage events with custom types (notify, prompt, intent, etc.)
    // These bypass the AppBridge protocol but are used by some MCP UI implementations
    window.addEventListener("message", async (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      
      // Skip AppBridge protocol messages (handled by bridge)
      if (data.jsonrpc || (typeof data.method === "string" && (data.method.startsWith("app/") || data.method.startsWith("host/")))) return;
      
      // Handle raw UI action messages
      const msgType = data.type;
      if (typeof msgType !== "string") return;
      
      if (msgType === "notify" || msgType === "prompt" || msgType === "intent" || msgType === "message") {
        // Standard MCP-UI types - preserve their semantics
        // Support both { type, payload: {...} } and { type, field: value } formats
        const { type: _, payload, ...directFields } = data;
        await post("/proxy/ui/message", { type: msgType, ...directFields, ...(payload || {}) }).catch(() => {});
      } else if (!msgType.startsWith("ui-lifecycle-") && !msgType.startsWith("ui-message-")) {
        // Any other custom type - forward as intent with type as intent name
        // (Skip internal lifecycle/ack messages)
        const payload = data.payload || {};
        await post("/proxy/ui/message", {
          type: "intent",
          intent: msgType,
          params: payload,
        }).catch(() => {});
      }
    });
    bridge.ondownloadfile = async (params) => post("/proxy/ui/download-file", params);
    bridge.onrequestdisplaymode = async (params) => post("/proxy/ui/request-display-mode", params);
    bridge.onopenlink = async (params) => {
      const result = await post("/proxy/ui/open-link", params);
      if (!result.isError) {
        window.open(params.url, "_blank", "noopener,noreferrer");
        // Notify agent about the link open
        await post("/proxy/ui/message", {
          type: "intent",
          intent: "open_link",
          params: { url: params.url }
        }).catch(() => {});
      }
      return result;
    };

    bridge.oninitialized = () => {
      if (streamMode !== "stream-first") {
        bridge.sendToolInput({ arguments: TOOL_ARGS });
      }
      setStatus(streamMode === "stream-first" ? "Streaming…" : "Connected");
    };

    bridge.onsizechange = ({ width, height }) => {
      if (typeof width === "number" && width > 0) {
        iframe.style.minWidth = Math.min(width, window.innerWidth - 24) + "px";
      }
      if (typeof height === "number" && height > 0) {
        iframe.style.height = Math.max(height, 320) + "px";
      }
    };

    if (ALLOW_ATTRIBUTE) {
      iframe.setAttribute("allow", ALLOW_ATTRIBUTE);
    }

    // Connect bridge BEFORE loading iframe to ensure we're listening when the app sends ui/initialize
    try {
      const transport = new PostMessageTransport(iframe.contentWindow, null);
      await bridge.connect(transport);
    } catch (error) {
      console.error("[host] Bridge connection failed:", error);
      showError("Failed to initialize AppBridge: " + String(error));
    }

    const iframeLoaded = new Promise((resolve) => {
      iframe.onload = resolve;
    });
    iframe.src = "/ui-app?session=" + encodeURIComponent(SESSION_TOKEN);
    await iframeLoaded;

    const eventSource = new EventSource("/events?session=" + encodeURIComponent(SESSION_TOKEN));
    eventSource.addEventListener("tool-input", (event) => {
      try {
        bridge.sendToolInput(JSON.parse(event.data));
      } catch (error) {
        showError("Failed to forward tool input: " + String(error));
      }
    });
    eventSource.addEventListener("tool-result", (event) => {
      try {
        bridge.sendToolResult(JSON.parse(event.data));
      } catch (error) {
        showError("Failed to forward tool result: " + String(error));
      }
    });
    eventSource.addEventListener("tool-cancelled", (event) => {
      try {
        bridge.sendToolCancelled(JSON.parse(event.data));
      } catch (error) {
        showError("Failed to forward cancellation: " + String(error));
      }
    });
    eventSource.addEventListener("result-patch", async (event) => {
      try {
        await bridge.notification({
          method: STREAM_PATCH_METHOD,
          params: JSON.parse(event.data),
        });
      } catch (error) {
        showError("Failed to forward stream patch: " + String(error));
      }
    });
    eventSource.addEventListener("host-context", (event) => {
      try {
        bridge.setHostContext(JSON.parse(event.data));
      } catch {}
    });
    eventSource.addEventListener("session-complete", async () => {
      await bridge.teardownResource({}).catch(() => {});
      eventSource.close();
      window.close();
    });
    eventSource.onerror = () => {
      setStatus("Connection lost", true);
    };

    const heartbeat = setInterval(() => {
      post("/proxy/ui/heartbeat", {}).catch(() => {});
    }, 10000);

    const complete = async (reason) => {
      try {
        await post("/proxy/ui/complete", { reason });
      } catch {}
      try {
        await bridge.teardownResource({});
      } catch {}
      clearInterval(heartbeat);
      eventSource.close();
      window.close();
    };

    doneBtn.addEventListener("click", () => complete("done"));
    cancelBtn.addEventListener("click", () => complete("cancel"));
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        complete("cancel");
      } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        complete("done");
      }
    });
  </script>
</body>
</html>`
}

export function buildCspMetaContent(csp: UiResourceCsp | undefined): string | undefined {
	if (!csp) return undefined

	const directives: string[] = []
	directives.push("default-src 'none'")

	const scriptSrc = toDirective("script-src", csp.scriptDomains)
	const styleSrc = toDirective("style-src", csp.styleDomains)
	const fontSrc = toDirective("font-src", csp.fontDomains)
	const imgSrc = toDirective("img-src", csp.imgDomains)
	const mediaSrc = toDirective("media-src", csp.mediaDomains)
	const connectSrc = toDirective("connect-src", csp.connectDomains)
	const frameSrc = toDirective("frame-src", csp.frameDomains)
	const workerSrc = toDirective("worker-src", csp.workerDomains)
	const baseUri = toDirective("base-uri", csp.baseUriDomains)

	if (scriptSrc) directives.push(scriptSrc)
	if (styleSrc) directives.push(styleSrc)
	if (fontSrc) directives.push(fontSrc)
	if (imgSrc) directives.push(imgSrc)
	if (mediaSrc) directives.push(mediaSrc)
	if (connectSrc) directives.push(connectSrc)
	if (frameSrc) directives.push(frameSrc)
	if (workerSrc) directives.push(workerSrc)
	if (baseUri) directives.push(baseUri)

	return directives.join("; ")
}

function toDirective(name: string, domains: string[] | undefined): string | null {
	if (!domains || domains.length === 0) return null
	return `${name} ${domains.join(" ")}`
}

export function applyCspMeta(html: string, cspContent: string | undefined): string {
	if (!cspContent) return html
	if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) return html
	const metaTag = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(cspContent)}">`
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head[^>]*>/i, (match) => `${match}\n${metaTag}`)
	}
	return `${metaTag}\n${html}`
}

function safeInlineJSON(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029")
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
}

function escapeHtmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
