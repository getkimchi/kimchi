import { useEffect, useState } from "react";
import ChatPage from "./pages/ChatPage";
import SetupPage from "./pages/SetupPage";

type KimchiState = "connecting" | "ready" | "error";

// index.html renders a static #splash overlay (🥢 Starting Kimchi... ● ● ●)
// so the window never shows blank while React/kimchi are booting. This
// component's job is just to know *when* that overlay should go away, and
// to keep its status line in sync in the meantime.
function setSplashVisible(visible: boolean, statusText?: string) {
    document.body.classList.toggle("app-ready", !visible);

    if (statusText) {
        const el = document.getElementById("splash-status");
        if (el) el.textContent = statusText;
    }
}

export default function App() {

    const [configured, setConfigured] = useState<boolean | null>(null);
    const [kimchiState, setKimchiState] = useState<KimchiState>("connecting");
    const [kimchiMessage, setKimchiMessage] = useState<string | undefined>(undefined);

    useEffect(() => {

        window.kimchi.isConfigured().then(setConfigured);

        // Pull the current status directly rather than only listening for
        // the next push — kimchi may have already finished connecting (or
        // failed) before this listener was attached, and we don't want the
        // splash stuck up forever waiting for an event that already fired.
        window.kimchi.getStatus().then(status => {
            setKimchiState(status.state);
            setKimchiMessage(status.message);
        });

        const unsubscribe = window.kimchi.onStatus(({ state, message }) => {
            setKimchiState(state);
            setKimchiMessage(message);
        });

        return unsubscribe;

    }, []);

    useEffect(() => {

        if (configured === null) {
            setSplashVisible(true, "Starting Kimchi...");
            return;
        }

        if (!configured) {
            // First-run setup doesn't need kimchi running yet.
            setSplashVisible(false);
            return;
        }

        if (kimchiState === "connecting") {
            setSplashVisible(true, "Starting Kimchi...");
        } else {
            // "ready" or "error" — either way, stop hiding the app behind
            // the splash. Errors are shown inline in ChatWindow so the user
            // can actually see what went wrong.
            setSplashVisible(false);
        }

    }, [configured, kimchiState, kimchiMessage]);

    const handleSetup = async (apiKey: string) => {

        await window.kimchi.setup(apiKey);

        const configured = await window.kimchi.isConfigured();

        setConfigured(configured);

    };

    if (configured === null)
        return null;

    return (

    <div className="app">

        {configured
            ? <ChatPage/>
            : <SetupPage onSetup={handleSetup}/>
        }

    </div>

);
}