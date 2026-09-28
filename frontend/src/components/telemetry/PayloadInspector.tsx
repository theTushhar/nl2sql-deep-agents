import { useState, useEffect } from "react";
import type { QueryPayload } from "../../lib/api";
import type { QueryResult } from "../../types";
import { useClipboard } from "../../hooks/useClipboard";
import { ResponseBodyViewer } from "./ResponseBodyViewer";

interface PayloadInspectorProps {
  currentPayload: QueryPayload;
  customPayload: QueryPayload | null;
  onCustomPayloadChange: (payload: QueryPayload | null) => void;
  lastResponse: QueryResult | null;
}

export function PayloadInspector({
  currentPayload,
  customPayload,
  onCustomPayloadChange,
  lastResponse,
}: PayloadInspectorProps) {
  const [activeTab, setActiveTab] = useState<"request" | "response">("request");
  const [isCustomMode, setIsCustomMode] = useState<boolean>(customPayload !== null);
  const [jsonText, setJsonText] = useState<string>(() =>
    JSON.stringify(customPayload || currentPayload, null, 2)
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const { copied: copiedReq, copy: copyReq } = useClipboard();

  useEffect(() => {
    if (!isCustomMode) {
      setJsonText(JSON.stringify(currentPayload, null, 2));
      setJsonError(null);
    }
  }, [currentPayload, isCustomMode]);

  function handleToggleCustom(enable: boolean) {
    setIsCustomMode(enable);
    if (!enable) {
      onCustomPayloadChange(null);
      setJsonText(JSON.stringify(currentPayload, null, 2));
      setJsonError(null);
    } else {
      try {
        const parsed = JSON.parse(jsonText);
        onCustomPayloadChange(parsed);
        setJsonError(null);
      } catch (err: unknown) {
        setJsonError(err instanceof Error ? err.message : "Invalid JSON");
      }
    }
  }

  function handleJsonChange(text: string) {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text);
      setJsonError(null);
      if (isCustomMode) {
        onCustomPayloadChange(parsed);
      }
    } catch (err: unknown) {
      setJsonError(err instanceof Error ? err.message : "Invalid JSON syntax");
    }
  }

  function handleReset() {
    setJsonText(JSON.stringify(currentPayload, null, 2));
    setJsonError(null);
    if (isCustomMode) {
      onCustomPayloadChange(currentPayload);
    }
  }

  const handleCopyRequest = () => copyReq(jsonText);

  const statusBadge = lastResponse?.statusCode != null
    ? `${lastResponse.statusCode} ${lastResponse.status === "error" ? "ERROR" : "OK"}`
    : lastResponse
      ? (lastResponse.status === "error" ? "ERROR" : "OK")
      : null;

  return (
    <div className="payload-inspector-container">
      <div className="inspector-subtabs">
        <button
          type="button"
          className={`inspector-tab-btn ${activeTab === "request" ? "active" : ""}`}
          onClick={() => setActiveTab("request")}
        >
          <span>REQUEST</span>
          <span className="tab-pill-badge">POST /api/query</span>
        </button>
        <button
          type="button"
          className={`inspector-tab-btn ${activeTab === "response" ? "active" : ""}`}
          onClick={() => setActiveTab("response")}
        >
          <span>RESPONSE</span>
          {statusBadge && <span className="tab-pill-badge success">{statusBadge}</span>}
        </button>
      </div>

      {activeTab === "request" && (
        <div className="inspector-panel request-panel">
          <div className="inspector-bar">
            <label className="custom-override-toggle" title="Enable direct editing of the outgoing JSON request payload">
              <input
                type="checkbox"
                checked={isCustomMode}
                onChange={(e) => handleToggleCustom(e.target.checked)}
              />
              <span className="toggle-slider" />
              <span className="toggle-label">Edit Custom Payload</span>
            </label>

            <div className="inspector-actions">
              {isCustomMode && (
                <button
                  type="button"
                  className="btn-text-action"
                  onClick={handleReset}
                  title="Reset to current toggles (domain / dialect / include_traces)"
                >
                  Reset
                </button>
              )}
              <button
                type="button"
                className="btn-text-action"
                onClick={handleCopyRequest}
                title="Copy Request JSON"
              >
                {copiedReq ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          {jsonError && <div className="json-error-banner">{jsonError}</div>}

          <div className="json-editor-wrap">
            <textarea
              className={`json-textarea ${isCustomMode ? "editable" : "readonly"}`}
              value={jsonText}
              onChange={(e) => handleJsonChange(e.target.value)}
              readOnly={!isCustomMode}
              rows={12}
              spellCheck={false}
            />
          </div>

          <div className="inspector-tip">
            {isCustomMode
              ? "⚡ Custom mode active: your exact JSON above will be sent to the backend."
              : "💡 Tip: use the DOMAIN / DIALECT / TRACES toggles above the input; enable 'Edit Custom Payload' to inject context_filters (tenant_id, user_id, etc.). Extra fields are echoed in data.echo."}
          </div>
        </div>
      )}

      {activeTab === "response" && (
        <div className="inspector-panel response-panel">
          <ResponseBodyViewer response={lastResponse} />
        </div>
      )}
    </div>
  );
}
