import "./Welcome.css";

import {
    Sparkles,
    Code,
    Wrench,
    FileCode
} from "lucide-react";

export default function Welcome() {

    return (

        <div className="welcome">

            <div className="welcome-logo">

                🥢

            </div>

            <h1>Kimchi</h1>

            <p>

                Build anything from prompt.

            </p>

            <div className="welcome-grid">

                <div className="welcome-card">

                    <Sparkles size={22} />

                    Explain code

                </div>

                <div className="welcome-card">

                    <Code size={22} />

                    Generate code

                </div>

                <div className="welcome-card">

                    <Wrench size={22} />

                    Fix errors

                </div>

                <div className="welcome-card">

                    <FileCode size={22} />

                    Refactor project

                </div>

            </div>

        </div>

    );

}