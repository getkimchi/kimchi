import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/index.css";
import "./styles/app.css";
import { ConversationProvider } from "./context/ConversationContext";
import { initTheme } from "./utils/theme";

initTheme();

ReactDOM.createRoot(
    document.getElementById("root")!
).render(

    <React.StrictMode>

        <ConversationProvider>

            <App />

        </ConversationProvider>
    </React.StrictMode>

);