import "./Header.css";

type Props = {
    status: "connecting" | "ready" | "error";
};

export default function Header({ status }: Props) {

    return (

        <header className="header">

            <div>

                <h1>Welcome to Kimchi</h1>

                <p>Your Open-Source Coding Assistant</p>
                
                
            </div>

            <div
                className={`status status-${status}`}
            >
                {status === "ready" && "● Connected"}

                {status === "connecting" && "● Connecting"}

                {status === "error" && "● Offline"}

            </div>

        </header>

    );

}