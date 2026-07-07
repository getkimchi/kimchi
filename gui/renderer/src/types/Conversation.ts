import { ChatMessage } from "./Message";

export interface Conversation{

    id:string;

    title:string;

    createdAt:Date;

    updatedAt:Date;

    messages:ChatMessage[];

}