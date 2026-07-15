import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import "./ThoughtPanel.css";

type Props = {
    thought: string;
    streaming: boolean;
};

export default function ThoughtPanel({ thought, streaming }: Props) {

    const [expanded, setExpanded] = useState(false);

    return (

        <div className="thought-panel">

            <button
                className="thought-header"
                onClick={() => setExpanded(!expanded)}
            >

                {expanded
                    ? <ChevronDown size={16} />
                    : <ChevronRight size={16} />
                }

                <span>{streaming ? "Thinking…" : "Thinking done"}</span>

                {streaming && (
                    <span className="thought-dots">
                        <span />
                        <span />
                        <span />
                    </span>
                )}

            </button>

            {expanded && (

                <div className="thought-content">

                    {thought}

                </div>

            )}

        </div>

    );

}