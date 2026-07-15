export {};

interface ChatChunk {
    sessionId: string;
    text: string;
}

interface KimchiStatus {
    state: "connecting" | "ready" | "error";
    message?: string;
}

declare global {
    interface Window {
        kimchi: {
            sendMessage(message: string): Promise<string>;
            isConfigured(): Promise<boolean>;
            setup(apiKey: string): Promise<boolean>;
            getStatus(): Promise<KimchiStatus>;
            getModels(): Promise<
                {
                    provider: string;
                    id: string;
                    name: string;
                    reasoning: boolean;
                    input: string[];
                    contextWindow: number;
                    maxTokens: number;
                }[]
            >;
            getCurrentModel(): Promise<
                | {
                    provider: string;
                    model: string;
                }
                | null
            >;
            setCurrentModel(
                modelId: string
            ): Promise<boolean>;

            deleteApiKey(): Promise<boolean>;

            onChunk(callback: (chunk: ChatChunk) => void): () => void;
            onThought(callback: (chunk: ChatChunk) => void): () => void;
            onStatus(callback: (status: KimchiStatus) => void): () => void;
        };
    }
}