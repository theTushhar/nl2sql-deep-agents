import { type ReactNode } from "react";

interface ContentWrapperProps {
  chat: ReactNode;
  sidebar: ReactNode;
}

export function ContentWrapper({ chat, sidebar }: ContentWrapperProps) {
  return (
    <div className="content-wrapper">
      <div className="chat-container">{chat}</div>
      <aside className="telemetry-sidebar">{sidebar}</aside>
    </div>
  );
}
