import "./Sidebar.css";
import { Plus } from "lucide-react";
import ConversationItem from "./ConversationItem";
import { useConversationContext } from "../../context/ConversationContext";
import { Settings } from "lucide-react";
import { useState } from "react";
import ConfirmDialog from "../ConfirmDialog/ConfirmDialog";

type Props = {
    onOpenSettings: () => void;
};

export default function Sidebar({ onOpenSettings }: Props) {

    const {

        conversations,

        currentConversationId,

        setCurrentConversationId,

        createConversation,

        deleteConversation

    } = useConversationContext();

    const [conversationToDelete, setConversationToDelete] = useState<string | null>(null);

    const today = conversations.filter(c =>

        new Date().toDateString() === c.createdAt.toDateString()

    );

    const yesterday = conversations.filter(c => {

        const d = new Date();

        d.setDate(d.getDate() - 1);

        return d.toDateString() === c.createdAt.toDateString();

    });

    const lastWeek = conversations.filter(c => {

        const diff = Date.now() - c.createdAt.getTime();

        return diff >= 86400000 * 2 && diff < 86400000 * 7;

    });

    return (

        <div className="sidebar">

            <button

                className="new-chat"

                onClick={createConversation}

            >

                <Plus size={18}/>

                New Chat

            </button>

            <div className="conversation-group">

                <h4>Today</h4>

                {today.map(c=>

                    <ConversationItem

                        key={c.id}

                        conversation={c}

                        selected={c.id === currentConversationId}

                        onClick={() => setCurrentConversationId(c.id)}

                        onDelete={() => setConversationToDelete(c.id)}

                    />

                )}

            </div>

            <div className="conversation-group">

                <h4>Yesterday</h4>

                {yesterday.map(c=>

                    <ConversationItem

                        key={c.id}

                        conversation={c}

                        selected={c.id === currentConversationId}

                        onClick={() => setCurrentConversationId(c.id)}
                        
                        onDelete={() => setConversationToDelete(c.id)}

                    />

                )}

            </div>

            <div className="conversation-group">

                <h4>Last Week</h4>

                {lastWeek.map(c=>

                    <ConversationItem

                        key={c.id}

                        conversation={c}

                        selected={c.id === currentConversationId}

                        onClick={() => setCurrentConversationId(c.id)}
                        onDelete={() => setConversationToDelete(c.id)}

                    />

                )}

            </div>
            <div className="sidebar-footer">

                <button className="settings-button" onClick={onOpenSettings}>

                    <Settings size={18} />

                    <span>Settings</span>

                </button>

            </div>

            <ConfirmDialog
                open={conversationToDelete !== null}
                title="Delete Conversation"
                message="Are you sure you want to delete this conversation? This action cannot be undone."
                confirmText="Delete"
                cancelText="Cancel"
                danger
                onCancel={() => setConversationToDelete(null)}
                onConfirm={() => {

                    if (conversationToDelete) {

                        deleteConversation(conversationToDelete);

                    }

                    setConversationToDelete(null);

                }}
            />
        </div>

    );

}