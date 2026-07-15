import { useState } from "react";
import Sidebar from "../components/Sidebar/Sidebar";
import ChatWindow from "../components/ChatWindow/ChatWindow";
import SettingsModal from "../components/Settings/SettingsModal";

export default function ChatPage() {

    const [settingsOpen, setSettingsOpen] = useState(false);

    return (

        <>

            <aside>

                <Sidebar onOpenSettings={() => setSettingsOpen(true)} />

            </aside>

            <main>

                <ChatWindow />

            </main>

            {settingsOpen && (
                <SettingsModal onClose={() => setSettingsOpen(false)} />
            )}

        </>

    );

}