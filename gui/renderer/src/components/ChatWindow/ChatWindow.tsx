import { useEffect, useRef } from "react";
import "./ChatWindow.css";
import ChatInput from "../ChatInput/ChatInput";
import Message from "../Message/Message";
import { useChat } from "../../hooks/useChat";
import Header from "../Header/Header";
import Welcome from "../Welcome/Welcome";

export default function ChatWindow() {

    const { messages, send, regenerate, connectionState, connectionMessage } = useChat();

    const bottomRef=useRef<HTMLDivElement>(null);

    useEffect(()=>{

        bottomRef.current?.scrollIntoView({

            behavior:"smooth"

        });

    },[messages]);

    return (

        <div className="chat-window">

            <Header status={connectionState} />

            {connectionState === "error" && connectionMessage && (
                <div className="connection-error-banner">
                    {connectionMessage}
                </div>
            )}

            <div className="chat-body">

                {
                    messages.length === 0
                        ? <Welcome />
                        : messages.map(m => (
                            <Message
                                key={m.id}
                                role={m.role}
                                text={m.text}
                                thought={m.thought}
                                streaming={m.streaming}
                                onRegenerate={() => regenerate(m.id)}
                                
                            />
                        ))
                }

                <div ref={bottomRef} />

            </div>

            <div className="chat-input">

                <ChatInput onSend={send} disabled={connectionState !== "ready"} />

            </div>

        </div>

    );

}