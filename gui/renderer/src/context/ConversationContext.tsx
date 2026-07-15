import {
    createContext,
    useContext,
    type ReactNode
} from "react";

import { useConversations } from "../hooks/useConversations";

const ConversationContext = createContext<
    ReturnType<typeof useConversations> | null
>(null);

type Props = {

    children: ReactNode;

};

export function ConversationProvider({

    children

}: Props) {

    const value = useConversations();

    return (

        <ConversationContext.Provider value={value}>

            {children}

        </ConversationContext.Provider>

    );

}

export function useConversationContext() {

    const context = useContext(ConversationContext);

    if (!context) {

        throw new Error(
            "useConversationContext must be used inside ConversationProvider."
        );

    }

    return context;

}