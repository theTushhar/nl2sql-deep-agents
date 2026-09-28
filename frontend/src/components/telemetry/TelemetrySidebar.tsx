import { useState } from "react";
import type { QueryResult, Telemetry } from "../../types";
import type { QueryPayload } from "../../lib/api";
import { PayloadInspector } from "./PayloadInspector";
import { TelemetryHeader } from "./TelemetryHeader";
import { LlmUsageCard } from "./LlmUsageCard";
import { TracesCard } from "./TracesCard";
import { SqlRunner } from "./SqlRunner";

export type SidebarTab = "telemetry" | "payload" | "sql-runner";

interface TelemetrySidebarProps {
  telemetry: Telemetry | null;
  currentPayload: QueryPayload;
  customPayload: QueryPayload | null;
  onCustomPayloadChange: (payload: QueryPayload | null) => void;
  lastResponse: QueryResult | null;
  sidebarTab?: SidebarTab;
  onSidebarTabChange?: (tab: SidebarTab) => void;
  lastGeneratedSql?: string | null;
  activeSqlRunnerQuery?: string | null;
}

function EmptyTelemetryState() {
  return (
    <>
      <TelemetryHeader />
      <div className="telemetry-empty-card">
        <div className="empty-icon-wrap">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        </div>
        <p className="empty-state-title">Awaiting Query Execution</p>
        <p className="empty-state-desc">Performance, token counts, and LLM trace diagnostics will appear here after your first question.</p>
      </div>
      <div className="telemetry-watermark">NL2SQL.AI</div>
    </>
  );
}

function PopulatedTelemetry({ telemetry }: { telemetry: Telemetry }) {
  return (
    <>
      <TelemetryHeader />
      <div className="telemetry-content">
        {telemetry.totalLatencyMs != null && (
          <div className="telemetry-card">
            <div className="card-header-bar">
              <span className="card-eyebrow">PERFORMANCE</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Total Latency</span>
              <span className="stat-value highlight-badge">{telemetry.totalLatencyMs}ms</span>
            </div>
          </div>
        )}

        {telemetry.llmTokens && (
          <LlmUsageCard
            tokens={telemetry.llmTokens}
            cost={telemetry.llmCost}
            callsCount={telemetry.llmCallsCount}
            model={telemetry.model}
          />
        )}

        {telemetry.llmTraces && telemetry.llmTraces.length > 0 && (
          <TracesCard traces={telemetry.llmTraces} />
        )}
      </div>
      <div className="telemetry-watermark">NL2SQL.AI</div>
    </>
  );
}

export function TelemetrySidebar({
  telemetry,
  currentPayload,
  customPayload,
  onCustomPayloadChange,
  lastResponse,
  sidebarTab,
  onSidebarTabChange,
  lastGeneratedSql,
  activeSqlRunnerQuery,
}: TelemetrySidebarProps) {
  const [internalTab, setInternalTab] = useState<SidebarTab>("telemetry");
  const currentTab = sidebarTab !== undefined ? sidebarTab : internalTab;

  function handleTabClick(tab: SidebarTab) {
    if (onSidebarTabChange) {
      onSidebarTabChange(tab);
    } else {
      setInternalTab(tab);
    }
  }

  return (
    <div className="telemetry-inner">
      <div className="sidebar-tab-bar">
        <button
          type="button"
          className={`sidebar-tab-btn ${currentTab === "telemetry" ? "active" : ""}`}
          onClick={() => handleTabClick("telemetry")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 20V10M12 20V4M6 20v-6" />
          </svg>
          <span>METRICS</span>
        </button>
        <button
          type="button"
          className={`sidebar-tab-btn ${currentTab === "payload" ? "active" : ""}`}
          onClick={() => handleTabClick("payload")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span>PAYLOAD</span>
          {customPayload && <span className="tab-custom-badge">EDITED</span>}
        </button>
        <button
          type="button"
          className={`sidebar-tab-btn ${currentTab === "sql-runner" ? "active" : ""}`}
          onClick={() => handleTabClick("sql-runner")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
          <span>SQL RUNNER</span>
        </button>
      </div>

      {currentTab === "sql-runner" ? (
        <SqlRunner
          lastGeneratedSql={lastGeneratedSql}
          activeSql={activeSqlRunnerQuery}
        />
      ) : currentTab === "payload" ? (
        <PayloadInspector
          currentPayload={currentPayload}
          customPayload={customPayload}
          onCustomPayloadChange={onCustomPayloadChange}
          lastResponse={lastResponse}
        />
      ) : !telemetry ? (
        <EmptyTelemetryState />
      ) : (
        <PopulatedTelemetry telemetry={telemetry} />
      )}
    </div>
  );
}
