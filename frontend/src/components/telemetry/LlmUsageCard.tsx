import type { LlmTokens } from "../../types";

interface LlmUsageCardProps {
  tokens: LlmTokens;
  cost?: number;
  callsCount?: number;
  model?: string;
}

export function LlmUsageCard({ tokens, cost, callsCount, model }: LlmUsageCardProps) {
  return (
    <div className="telemetry-card">
      <div className="card-header-bar">
        <span className="card-eyebrow">LLM USAGE</span>
      </div>
      {model && (
        <div className="stat-row">
          <span className="stat-label">Model</span>
          <span className="stat-value font-mono">{model}</span>
        </div>
      )}
      <div className="stat-row">
        <span className="stat-label">API Calls</span>
        <span className="stat-value">{callsCount || 0}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Total Tokens</span>
        <span className="stat-value font-mono">{tokens.totalTokens.toLocaleString()}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Prompt Tokens</span>
        <span className="stat-value font-mono">{tokens.inputTokens.toLocaleString()}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Completion Tokens</span>
        <span className="stat-value font-mono">{tokens.outputTokens.toLocaleString()}</span>
      </div>
      <div className="stat-row stat-row-cost">
        <span className="stat-label">Est. Cost</span>
        <span className="stat-value cost-value">
          ${(cost ? cost.toFixed(4) : "0.0000")}
        </span>
      </div>
    </div>
  );
}
