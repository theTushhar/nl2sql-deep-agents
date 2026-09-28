import { useCallback, useState } from "react";
import type { Message } from "../types";

let messageIdCounter = 0;
function nextMessageId(): string {
  return `msg-${++messageIdCounter}-${Date.now()}`;
}

const WELCOME_MESSAGE: Message = {
  id: "welcome",
  type: "system",
  content:
    "Welcome! I am your NL2SQL assistant. Ask me anything about your data \u2014 I will convert your question into SQL and fetch the answer.",
  timestamp: Date.now(),
};

export function useChatMessages() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);

  const addMessage = useCallback(
    (type: Message["type"], content: Message["content"]) => {
      const msg: Message = {
        id: nextMessageId(),
        type,
        content,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, msg]);
      return msg;
    },
    [],
  );

  return { messages, addMessage };
}
