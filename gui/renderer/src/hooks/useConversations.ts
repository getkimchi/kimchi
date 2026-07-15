import { useEffect, useState } from "react";
import type { Conversation } from "../types/Conversation";
import type { ChatMessage } from "../types/Message";

const DEFAULT_CONVERSATIONS: Conversation[] = [];

export function useConversations() {

    const [conversations, setConversations] = useState<Conversation[]>(() => {

        const saved = localStorage.getItem("kimchi-conversations");

        if (saved) {
            try {

                const parsed = JSON.parse(saved) as Conversation[];

                return parsed.map(c => ({

                    ...c,

                    createdAt: new Date(c.createdAt),

                    updatedAt: new Date(c.updatedAt)

                }));
            } catch {

                return DEFAULT_CONVERSATIONS;

            }
        }

        return [
            {
                id: crypto.randomUUID(),
                title: "New Chat",
                createdAt: new Date(),
                updatedAt: new Date(),
                messages: []
            }
        ];

    });

    const [currentConversationId, setCurrentConversationId] = useState(() => {

        const saved = localStorage.getItem(
            "kimchi-current-conversation"
        );

        if (saved) {

            return saved;

        }

        return conversations[0]?.id;

    });

    const currentConversation =
        conversations.find(c => c.id === currentConversationId) ?? null;

    useEffect(() => {

        if (

            conversations.length > 0 &&

            !currentConversation

        ) {

            setCurrentConversationId(conversations[0].id);

        }

    }, [conversations, currentConversation]);

    const createConversation = () => {

        const conversation: Conversation = {

            id: crypto.randomUUID(),

            title: "New Chat",

            createdAt: new Date(),

            updatedAt: new Date(),

            messages: []

        };

        setConversations(prev => [conversation, ...prev]);

        setCurrentConversationId(conversation.id);

        return conversation.id;

    };

    // Save conversations

    useEffect(() => {

        localStorage.setItem(

            "kimchi-conversations",

            JSON.stringify(conversations)

        );

    }, [conversations]);

    // Save currently selected conversation

    useEffect(() => {

        if (currentConversationId) {

            localStorage.setItem(

                "kimchi-current-conversation",

                currentConversationId

            );

        }

    }, [currentConversationId]);

    function addMessage(

        conversationId: string,

        message: ChatMessage

    ) {

        setConversations(prev =>

            prev.map(c =>

                c.id === conversationId

                    ? {

                        ...c,

                        updatedAt: new Date(),

                        messages: [...c.messages, message]

                    }

                    : c

            )

        );

    }

    function updateMessage(

        conversationId: string,

        messageId: string,

        updater: (m: ChatMessage) => ChatMessage

    ) {

        setConversations(prev =>

            prev.map(c =>

                c.id === conversationId

                    ? {

                        ...c,

                        messages: c.messages.map(m =>

                            m.id === messageId

                                ? updater(m)

                                : m

                        )

                    }

                    : c

            )

        );

    }

    function removeMessage(

        conversationId: string,

        messageId: string

    ) {

        setConversations(prev =>

            prev.map(c =>

                c.id === conversationId

                    ? {

                        ...c,

                        updatedAt: new Date(),

                        messages: c.messages.filter(

                            m => m.id !== messageId

                        )

                    }

                    : c

            )

        );

    }

    function renameConversation(

        conversationId: string,

        title: string

    ) {

        setConversations(prev =>

            prev.map(c =>

                c.id === conversationId

                    ? {

                        ...c,

                        title,

                        updatedAt: new Date()

                    }

                    : c

            )

        );

    }

    function deleteConversation(conversationId: string) {

        const remaining = conversations.filter(
            c => c.id !== conversationId
        );

        if (remaining.length === 0) {

            const conversation: Conversation = {

                id: crypto.randomUUID(),

                title: "New Chat",

                createdAt: new Date(),

                updatedAt: new Date(),

                messages: []

            };

            setConversations([conversation]);
            setCurrentConversationId(conversation.id);

            return;
        }

        setConversations(remaining);

        if (currentConversationId === conversationId) {

            setCurrentConversationId(remaining[0].id);

        }

    }

    return {

        conversations,

        currentConversation,

        currentConversationId,

        setCurrentConversationId,

        createConversation,

        deleteConversation,

        addMessage,

        updateMessage,

        removeMessage,

        renameConversation,

        setConversations

    };

}