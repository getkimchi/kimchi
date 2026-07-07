import "./ConversationItem.css";
import type { Conversation } from "../../types/Conversation";
import { Trash2 } from "lucide-react";

type Props = {

    conversation: Conversation;

    selected: boolean;

    onClick: () => void;

    onDelete: () => void;

};

export default function ConversationItem({

    conversation,

    selected,

    onClick,

    onDelete

}: Props) {

    return (

        <button

            className={`conversation-item ${selected ? "active" : ""}`}

            onClick={onClick}

        >

            <span className="conversation-title">

                {conversation.title}

            </span>

            <Trash2

                size={16}

                className="conversation-delete"

                onClick={(e) => {

                    e.stopPropagation();

                    onDelete();

                }}

            />

        </button>

    );

}