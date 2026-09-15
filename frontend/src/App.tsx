import { useRef } from "react";
import { useChat } from "./hooks/useChat";
import { useAuth } from "./hooks/useAuth";
import { useApiKey } from "./hooks/useApiKey";
import { AppHeader } from "./components/layout/AppHeader";
import { LoginPage } from "./components/layout/LoginPage";
import { ContentWrapper } from "./components/layout/ContentWrapper";
import { ChatHistory } from "./components/chat/ChatHistory";
import { ChatInput } from "./components/chat/ChatInput";
import { NodeStatus } from "./components/chat/NodeStatus";
import { TelemetrySidebar } from "./components/telemetry/TelemetrySidebar";

export default function App() {
  const { authenticated, handleAuthenticated, handleLogout } = useAuth();
  const {
    messages,
    isStreaming,
    nodeStatus,
    telemetry,
    sendQuestion,
    selectedDomain,
    setSelectedDomain,
    selectedDialect,
    setSelectedDialect,
    includeTraces,
    setIncludeTraces,
    includeSql,
    setIncludeSql,
    includeAst,
    setIncludeAst,
    customPayload,
    setCustomPayload,
    lastRequestPayload,
    lastResponsePayload,
    sidebarTab,
    setSidebarTab,
    lastGeneratedSql,
    activeSqlRunnerQuery,
  } = useChat();
  const { isConfigured, setApiKey, promptForApiKey } = useApiKey();
  const inputRef = useRef<HTMLInputElement>(null);

  const onAuthenticated = (authKey: string) => {
    setApiKey(authKey);
    handleAuthenticated(authKey);
  };

  if (!authenticated) {
    return <LoginPage onAuthenticated={onAuthenticated} />;
  }

  return (
    <div className="app-container">
      <AppHeader
        isApiKeyConfigured={isConfigured}
        onApiKeyClick={promptForApiKey}
        onLogout={handleLogout}
      />
      <ContentWrapper
        chat={
          <>
            <ChatHistory messages={messages} />
            <NodeStatus status={nodeStatus} />
            <ChatInput
              inputRef={inputRef}
              isDisabled={isStreaming}
              onSubmit={sendQuestion}
              selectedDomain={selectedDomain}
              onDomainChange={setSelectedDomain}
              selectedDialect={selectedDialect}
              onDialectChange={setSelectedDialect}
              includeTraces={includeTraces}
              onIncludeTracesChange={setIncludeTraces}
              includeSql={includeSql}
              onIncludeSqlChange={setIncludeSql}
              includeAst={includeAst}
              onIncludeAstChange={setIncludeAst}
              onOpenPayloadInspector={() => setSidebarTab("payload")}
              isCustomPayloadActive={customPayload !== null}
            />
          </>
        }
        sidebar={
          <TelemetrySidebar
            telemetry={telemetry}
            currentPayload={lastRequestPayload}
            customPayload={customPayload}
            onCustomPayloadChange={setCustomPayload}
            lastResponse={lastResponsePayload}
            sidebarTab={sidebarTab}
            onSidebarTabChange={setSidebarTab}
            lastGeneratedSql={lastGeneratedSql}
            activeSqlRunnerQuery={activeSqlRunnerQuery}
          />
        }
      />
    </div>
  );
}
