import { useEffect, useRef } from "react";
import type { Message } from "../../types";

interface ChatHistoryProps {
  messages: Message[];
}

export function ChatHistory({ messages }: ChatHistoryProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="chat-history">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.type === "user";
  const isError = message.type === "error";

  const className = isError
    ? "message system-message message-error"
    : `message ${message.type}-message`;

  return (
    <div className={className}>
      <div className="message-header-tag">
        {isUser ? (
          <span className="eyebrow-tag user-tag">YOU</span>
        ) : isError ? (
          <span className="eyebrow-tag error-tag">
            <span className="error-dot" />
            SYSTEM ERROR
          </span>
        ) : (
          <span className="eyebrow-tag system-tag">
            <span className="agent-gradient-dot" />
            NL2SQL AGENT
          </span>
        )}
      </div>
      <div className="message-bubble">{message.content}</div>
    </div>
  );
}
