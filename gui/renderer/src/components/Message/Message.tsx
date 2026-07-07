import { useState } from "react";
import "./Message.css";
import MarkdownRenderer from "../Markdown/MarkdownRenderer";
import ThoughtPanel from "../ThoughtPanel/ThoughtPanel";
import {
    Copy,
    RotateCcw,
    Check
} from "lucide-react";

type Props = {

    role: "user" | "assistant";

    text: string;

    thought: string;

    streaming: boolean;

    onRegenerate?: () => void;

};

export default function Message({

    role,

    text,

    thought,

    streaming,

    onRegenerate

}: Props) {

    const [copied, setCopied] = useState(false);

    async function handleCopy() {

        try {

            await navigator.clipboard.writeText(text);

            setCopied(true);

            setTimeout(() => {

                setCopied(false);

            }, 2000);

        } catch {


        }

    }

    return (

        <div className={`message ${role}`}>

            <div className="bubble">

            <div className="message-content">

                {thought && (
                    <ThoughtPanel thought={thought} streaming={streaming && !text} />
                )}

                {text ? (
                    <>
                        <MarkdownRenderer text={text} />

                        {streaming && (
                            <span className="streaming-cursor">▍</span>
                        )}
                    </>
                ) : (
                    <div className="typing">

                        <span />
                        <span />
                        <span />

                    </div>
                )}

                {role === "assistant" && text && (

                    <div className="message-actions">

                        <button
                            onClick={handleCopy}
                            title={copied ? "Copied!" : "Copy"}
                        >
                            {copied
                                ? <Check size={15} />
                                : <Copy size={15} />
                            }
                        </button>

                        <button
                            onClick={onRegenerate}
                            title="Regenerate"
                        >
                            <RotateCcw size={15} />
                        </button>

                    </div>

                )}

            </div>

            </div>

        </div>

    );

}