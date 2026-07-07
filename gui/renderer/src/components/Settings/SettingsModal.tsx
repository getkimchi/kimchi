import { useState } from "react";
import { X, Sun, Moon, Trash2 } from "lucide-react";
import "./SettingsModal.css";
import { getStoredTheme, setTheme, type Theme } from "../../utils/theme";
import { cleanIpcErrorMessage } from "../../utils/ipcError";

type Props = {
    onClose: () => void;
};

export default function SettingsModal({ onClose }: Props) {

    const [theme, setThemeState] = useState<Theme>(getStoredTheme());
    const [apiKey, setApiKey] = useState("");
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    function handleThemeChange(next: Theme) {
        setThemeState(next);
        setTheme(next);
    }

    // Exactly what SetupPage does on first run — same IPC call, same
    // behavior. Adding/replacing a key from Settings is just that flow
    // triggered from a different screen.
    async function handleSaveKey() {
        if (!apiKey.trim()) return;

        try {
            setSaving(true);
            setError("");
            setMessage("");

            await window.kimchi.setup(apiKey);

            setMessage("API key saved. Kimchi is reconnecting...");
            setApiKey("");
        } catch (err) {
            setError(cleanIpcErrorMessage(err));
        } finally {
            setSaving(false);
        }
    }

    async function handleDeleteKey() {
        const confirmed = window.confirm(
            "Remove the saved API key? Kimchi won't be able to respond until you add a new one."
        );

        if (!confirmed) return;

        try {
            setDeleting(true);
            setError("");
            setMessage("");

            await window.kimchi.deleteApiKey();

            // Simplest way to get the whole app back to a clean, correct
            // state (same as a fresh launch with no key configured) —
            // reload so App.tsx re-checks isConfigured() from scratch.
            window.location.reload();
        } catch (err) {
            setError(cleanIpcErrorMessage(err));
            setDeleting(false);
        }
    }

    return (

        <div className="settings-overlay" onClick={onClose}>

            <div className="settings-modal" onClick={(e) => e.stopPropagation()}>

                <div className="settings-header">

                    <h2>Settings</h2>

                    <button className="settings-close" onClick={onClose}>
                        <X size={18} />
                    </button>

                </div>

                <div className="settings-section">

                    <h3>Appearance</h3>

                    <div className="theme-options">

                        <button
                            className={`theme-option ${theme === "light" ? "active" : ""}`}
                            onClick={() => handleThemeChange("light")}
                        >
                            <Sun size={16} />
                            Light
                        </button>

                        <button
                            className={`theme-option ${theme === "dark" ? "active" : ""}`}
                            onClick={() => handleThemeChange("dark")}
                        >
                            <Moon size={16} />
                            Dark
                        </button>

                    </div>

                </div>

                <div className="settings-section">

                    <h3>API Key</h3>

                    <p className="settings-hint">
                        Add a new key to replace the current one, or remove it entirely.
                    </p>

                    <div className="api-key-row">

                        <input
                            className="settings-input"
                            type="password"
                            placeholder="New API Key"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                        />

                        <button
                            className="btn-primary"
                            disabled={saving || !apiKey.trim()}
                            onClick={handleSaveKey}
                        >
                            {saving ? "Saving..." : "Save"}
                        </button>

                    </div>

                    <button
                        className="delete-key-button"
                        disabled={deleting}
                        onClick={handleDeleteKey}
                    >
                        <Trash2 size={15} />
                        {deleting ? "Removing..." : "Remove API Key"}
                    </button>

                    {message && <p className="settings-message">{message}</p>}
                    {error && <p className="settings-error">{error}</p>}

                </div>

            </div>

        </div>

    );

}
