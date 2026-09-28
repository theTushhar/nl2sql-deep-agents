import { type FormEvent, type RefObject } from "react";
import { DIALECT_OPTIONS, DOMAIN_OPTIONS } from "../../lib/constants";

interface ChatInputProps {
  inputRef: RefObject<HTMLInputElement | null>;
  isDisabled: boolean;
  onSubmit: (question: string) => void;
  selectedDomain: string;
  onDomainChange: (domain: string) => void;
  selectedDialect: string;
  onDialectChange: (dialect: string) => void;
  includeTraces: boolean;
  onIncludeTracesChange: (value: boolean) => void;
  onOpenPayloadInspector: () => void;
  isCustomPayloadActive: boolean;
}

export function ChatInput({
  inputRef,
  isDisabled,
  onSubmit,
  selectedDomain,
  onDomainChange,
  selectedDialect,
  onDialectChange,
  includeTraces,
  onIncludeTracesChange,
  onOpenPayloadInspector,
  isCustomPayloadActive,
}: ChatInputProps) {
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const input = inputRef.current;
    if (!input) return;

    const question = input.value.trim();
    if (!question || isDisabled) return;

    onSubmit(question);
    input.value = "";
    input.focus();
  }

  return (
    <div className="input-area">
      <div className="input-toolbar">
        <div className="toolbar-group domain-group">
          <span className="toolbar-label">DOMAIN:</span>
          <div className="domain-select-wrapper">
            <select
              className="domain-select"
              value={selectedDomain}
              onChange={(e) => onDomainChange(e.target.value)}
              title="Select targeted domain rules & schema context (default auto-routes)"
            >
              {DOMAIN_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <div className="select-arrow-icon">{"\u25BE"}</div>
          </div>
        </div>

        <div className="toolbar-group domain-group">
          <span className="toolbar-label">DIALECT:</span>
          <div className="domain-select-wrapper">
            <select
              className="domain-select"
              value={selectedDialect}
              onChange={(e) => onDialectChange(e.target.value)}
              title="SQL rendering dialect (mysql | mssql)"
            >
              {DIALECT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <div className="select-arrow-icon">{"\u25BE"}</div>
          </div>
        </div>

        <label
          className="toolbar-payload-btn"
          title="When on, backend includes per-stage LLM traces (prompts & responses) in telemetry"
        >
          <input
            type="checkbox"
            checked={includeTraces}
            onChange={(e) => onIncludeTracesChange(e.target.checked)}
          />
          <span>TRACES</span>
          <span className={`custom-indicator-tag ${includeTraces ? "" : "off"}`}>
            {includeTraces ? "ON" : "OFF"}
          </span>
        </label>

        <button
          type="button"
          className={`toolbar-payload-btn ${isCustomPayloadActive ? "custom-active" : ""}`}
          onClick={onOpenPayloadInspector}
          title="Open Request / Response Payload Inspector in sidebar"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span>Payload</span>
          {isCustomPayloadActive && <span className="custom-indicator-tag">CUSTOM</span>}
        </button>
      </div>

      <form className="chat-form" onSubmit={handleSubmit}>
        <div className="input-wrapper">
          <div className="input-prefix-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
          <input
            ref={inputRef}
            type="text"
            id="questionInput"
            placeholder="Ask a question about your database in plain English..."
            autoComplete="off"
            disabled={isDisabled}
            required
          />
          <button
            type="submit"
            id="sendButton"
            disabled={isDisabled}
            title="Execute natural language query"
          >
            <span className="send-btn-label">RUN QUERY</span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
        <div className="input-meta-bar">
          <span className="input-meta-item">
            <kbd className="meta-kbd">ENTER</kbd> TO RUN
          </span>
          <span className="input-meta-dot">{"\u00B7"}</span>
          <span className="input-meta-item">
            TARGET: <code>/api/query</code>
          </span>
          {selectedDomain && (
            <>
              <span className="input-meta-dot">{"\u00B7"}</span>
              <span className="input-meta-item">
                DOMAIN: <code>{selectedDomain}</code>
              </span>
            </>
          )}
          {selectedDialect && (
            <>
              <span className="input-meta-dot">{"\u00B7"}</span>
              <span className="input-meta-item">
                DIALECT: <code>{selectedDialect}</code>
              </span>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
