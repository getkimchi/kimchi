export interface ChatMessage {

    id: string;

    role: "user" | "assistant";

    text: string;

    thought: string;

    streaming: boolean;

}