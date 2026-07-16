import { useState, useEffect, KeyboardEvent } from "react";
import { Paperclip, SendHorizontal } from "lucide-react";
import "./ChatInput.css";

type Props = {
    onSend: (message: string) => Promise<void>;
    disabled?: boolean;
};

export default function ChatInput({
    onSend,
    disabled = false,
}: Props) {

    const [message, setMessage] = useState("");
    const [sending, setSending] = useState(false);
    const [models, setModels] = useState<
        {
            provider: string;
            id: string;
            name: string;
            reasoning: boolean;
            input: string[];
            contextWindow: number;
            maxTokens: number;
        }[]
    >([]);

    const [selectedModel, setSelectedModel] = useState("");

    useEffect(() => {

    async function loadModels() {

        try {

            const models = await window.kimchi.getModels();

            setModels(models);

            const current = await window.kimchi.getCurrentModel();

            if (current) {

                const selected = models.find(
                    m => m.id === current.model
                );

                if (selected) {

                    setSelectedModel(selected.id);

                    return;
                }
            }

            if (models.length > 0) {
                setSelectedModel(models[0].id);
            }

        } catch (err) {

            console.error("Failed to load models:", err);

        }
    }

        void loadModels();

    }, []);

    async function handleSend() {

        const text = message.trim();

        if (!text || sending || disabled) {
            return;
        }

        setSending(true);

        try {

            await onSend(text);

            setMessage("");

        } finally {

            setSending(false);

        }

    }

    function handleKeyDown(
        e: KeyboardEvent<HTMLTextAreaElement>
    ) {

        if (
            e.key === "Enter" &&
            !e.shiftKey
        ) {

            e.preventDefault();

            void handleSend();

        }

    }

    return (

        <div className="input-wrapper">

            <button
                className="attach"
                type="button"
                title="Attachments coming soon"
                disabled
            >
                <Paperclip size={18} />
            </button>

            <textarea
                placeholder="Ask Kimchi anything..."
                value={message}
                disabled={disabled || sending}
                rows={1}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                onInput={(e) => {

                    const el = e.currentTarget;

                    el.style.height = "0px";
                    el.style.height = `${el.scrollHeight}px`;

                }}
            />

            <select
                className="model-selector"
                value={selectedModel}
                disabled={disabled || sending}
                onChange={async (e) => {

                    const value = e.target.value;
                    const previous = selectedModel;

                    try {

                        await window.kimchi.setCurrentModel(value);

                        setSelectedModel(value);

                    } catch (err) {

                        console.error("setCurrentModel failed:", err);

                        setSelectedModel(previous);

                    }

                }}
            >

                {models.map(model => (

                    <option
                        key={model.id}
                        value={model.id}
                    >
                        {model.name}
                    </option>

                ))}

            </select>

            <button
                className="send"
                type="button"
                onClick={() => void handleSend()}
                disabled={
                    disabled ||
                    sending ||
                    message.trim().length === 0
                }
            >
                <SendHorizontal size={18} />
            </button>

        </div>

    );

}