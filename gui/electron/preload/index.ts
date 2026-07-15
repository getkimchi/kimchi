import { contextBridge, ipcRenderer } from "electron";

console.log("✅ Preload loaded");

export interface ChatChunk {
    sessionId: string;
    text: string;
}

export interface KimchiStatus {
    state: "connecting" | "ready" | "error";
    message?: string;
}


contextBridge.exposeInMainWorld("kimchi", {

    sendMessage(message: string) {
        return ipcRenderer.invoke("chat:send", message);
    },

        setup(apiKey: string) {
        return ipcRenderer.invoke("kimchi:setup", apiKey);
    },

    isConfigured() {
        return ipcRenderer.invoke("kimchi:isConfigured");
    },

    getStatus() {
        return ipcRenderer.invoke("kimchi:getStatus");
    },

    getModels() {
        return ipcRenderer.invoke("kimchi:getModels");
    },

    getCurrentModel() {
        return ipcRenderer.invoke("kimchi:getCurrentModel");
    },

    setCurrentModel(modelId: string) {
        return ipcRenderer.invoke("kimchi:setCurrentModel", modelId);
    },

    deleteApiKey() {
        return ipcRenderer.invoke("kimchi:deleteApiKey");
    },

    // Returns an unsubscribe function.
    onChunk(callback: (chunk: ChatChunk) => void) {
        const listener = (_event: Electron.IpcRendererEvent, chunk: ChatChunk) => callback(chunk);
        ipcRenderer.on("chat:chunk", listener);
        return () => ipcRenderer.removeListener("chat:chunk", listener);
    },

    // Returns an unsubscribe function.
    onThought(callback: (chunk: ChatChunk) => void) {
        const listener = (_event: Electron.IpcRendererEvent, chunk: ChatChunk) => callback(chunk);
        ipcRenderer.on("chat:thought", listener);
        return () => ipcRenderer.removeListener("chat:thought", listener);
    },

    // Returns an unsubscribe function.
    onStatus(callback: (status: KimchiStatus) => void) {
        const listener = (_event: Electron.IpcRendererEvent, status: KimchiStatus) => callback(status);
        ipcRenderer.on("kimchi:status", listener);
        return () => ipcRenderer.removeListener("kimchi:status", listener);
    }

});