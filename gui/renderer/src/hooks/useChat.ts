import { useEffect, useRef, useState } from "react";
import { useConversationContext } from "../context/ConversationContext";
import type { ChatMessage } from "../types/Message";


export type KimchiConnectionState = "connecting" | "ready" | "error";

export function useChat() {

    const {currentConversation, addMessage, updateMessage, renameConversation, removeMessage} = useConversationContext();
    const messages = currentConversation?.messages ?? [];
    const [connectionState, setConnectionState] = useState<KimchiConnectionState>("connecting");
    const [connectionMessage, setConnectionMessage] = useState<string | undefined>(undefined);

    // Tracks which assistant message the next incoming chunk/thought should be appended to.
    const activeAssistantId = useRef<string | null>(null);


    useEffect(() => {

        async function loadInitialStatus() {

            const status = await window.kimchi.getStatus();

            setConnectionState(status.state);

            setConnectionMessage(status.message);

        }

        void loadInitialStatus();

    }, []);

    useEffect(() => {

        const unsubscribeChunk = window.kimchi.onChunk(({ text }) => {

            const id = activeAssistantId.current;
            if (!id) return; // stray chunk with nothing in-flight — ignore

            if (!currentConversation) {
                return;
            }

            updateMessage(currentConversation.id, id, m => ({...m, text: m.text + text}));

        });

        const unsubscribeThought = window.kimchi.onThought(({ text }) => {

            const id = activeAssistantId.current;
            if (!id) return;

            if (!currentConversation) {
                return;
            }

            updateMessage(currentConversation.id, id, m => ({...m,thought: m.thought + text}));

        });

        const unsubscribeStatus = window.kimchi.onStatus(({ state, message }) => {
            setConnectionState(state);
            setConnectionMessage(message);
        });

        return () => {
            unsubscribeChunk();
            unsubscribeThought();
            unsubscribeStatus();
        };

    }, [currentConversation, updateMessage]);

    async function sendMessage(text: string, addUserMessage: boolean = true, assistantId?: string) {

        const currentAssistantId = assistantId ?? crypto.randomUUID();

        activeAssistantId.current = currentAssistantId;

        if (!currentConversation) {
            return;
        }

        if (addUserMessage) {

            const userMessage: ChatMessage = {

                id: crypto.randomUUID(),

                role: "user",

                text,

                thought: "",

                streaming: false

            };

            addMessage(currentConversation.id, userMessage);

            if (currentConversation.title === "New Chat") {

                renameConversation(

                    currentConversation.id,

                    text.length > 40

                        ? text.slice(0, 40) + "..."

                        : text

                );

            }

        }

        const assistantMessage: ChatMessage = {

            id: currentAssistantId,

            role: "assistant",

            text: "",

            thought: "",

            streaming: true

        };

        if (!assistantId) {

            addMessage(currentConversation.id, assistantMessage);

        }

        try {

            await window.kimchi.sendMessage(text);

        } catch {

            updateMessage(

                currentConversation.id,

                currentAssistantId,

                m => ({

                    ...m,

                    text: m.text || "❌ Failed to communicate with Kimchi."

                })

            );

        } finally {

            updateMessage(

                currentConversation.id,

                currentAssistantId,

                m => ({

                    ...m,

                    streaming: false

                })

            );

            activeAssistantId.current = null;

        }

    }

    async function send(text: string) {

        await sendMessage(text, true);

    }

    async function regenerate(assistantMessageId: string) {

        if (!currentConversation) {
            return;
        }

        const messages = currentConversation.messages;

        const assistantIndex = messages.findIndex(
            m => m.id === assistantMessageId
        );

        if (assistantIndex <= 0) {
            return;
        }

        const previousUser = [...messages]
            .slice(0, assistantIndex)
            .reverse()
            .find(m => m.role === "user");

        if (!previousUser) {
            return;
        }

        removeMessage(currentConversation.id, assistantMessageId);

        await sendMessage(previousUser.text, false);

    }

    return {
        messages,
        send,
        regenerate,
        connectionState,
        connectionMessage
    };

}
