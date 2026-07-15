import { useState } from "react";
import "./SetupPage.css";
import { cleanIpcErrorMessage } from "../utils/ipcError";

type Props = {
    onSetup: (apiKey: string) => Promise<void>;
};

export default function SetupPage({ onSetup }: Props) {

    const [apiKey, setApiKey] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const handleClick = async () => {
        try {
            setLoading(true);
            setError("");

            await onSetup(apiKey);
        } catch (err) {
            setError(cleanIpcErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="setup-page">

            <div className="setup-card">

                <div className="setup-emoji">🥢</div>

                <h1>Welcome to Kimchi</h1>

                <p>Enter your API key to configure Kimchi.</p>

                <input
                    className="setup-input"
                    type="password"
                    placeholder="API Key"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !loading && apiKey.trim() && handleClick()}
                    autoFocus
                />

                <button
                    className="btn-primary setup-submit"
                    disabled={loading || !apiKey.trim()}
                    onClick={handleClick}
                >
                    {loading ? "Configuring..." : "Save & Continue"}
                </button>

                {error && <p className="setup-error">{error}</p>}

            </div>

        </div>
    );
}
