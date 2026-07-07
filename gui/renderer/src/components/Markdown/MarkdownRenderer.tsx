import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
    Prism as SyntaxHighlighter
} from "react-syntax-highlighter";

import {
    oneLight
} from "react-syntax-highlighter/dist/esm/styles/prism";

import "./MarkdownRenderer.css";

export default function MarkdownRenderer({

    text

}:{

    text:string;

}){

    return(

        <ReactMarkdown

            remarkPlugins={[remarkGfm]}

            components={{

                code({

                    inline,

                    className,

                    children,

                    ...props

                }){

                    const match=/language-(\w+)/.exec(className||"");

                    if(!inline&&match){

                        return(

                            <SyntaxHighlighter

                                style={oneLight}

                                language={match[1]}

                                PreTag="div"

                                {...props}

                            >

                                {String(children).replace(/\n$/,"")}

                            </SyntaxHighlighter>

                        );

                    }

                    return(

                        <code

                            className={className}

                            {...props}

                        >

                            {children}

                        </code>

                    );

                }

            }}

        >

            {text}

        </ReactMarkdown>

    );

}