import { useState } from "react";
import type { LlmTrace } from "../../types";

interface TraceItemProps {
  index: number;
  trace: LlmTrace;
}

export function TraceItem({ index, trace }: TraceItemProps) {
  const [isOpen, setIsOpen] = useState(false);
  const title = trace.stage ? `${trace.stage}` : `TRACE #${index + 1}`;
  const meta: string[] = [];
  if (trace.model) meta.push(trace.model);
  if (trace.latencyMs != null) meta.push(`${trace.latencyMs}ms`);

  return (
    <details className="trace-details" open={isOpen} onToggle={(e) => setIsOpen(e.currentTarget.open)}>
      <summary>
        <span className="summary-indicator">{isOpen ? "\u25BE" : "\u25B8"}</span>
        <span className="summary-title">{title}</span>
        {meta.length > 0 && <span className="card-count-pill">{meta.join(" · ")}</span>}
      </summary>
      <div className="trace-content">
        <div className="trace-section">
          <div className="trace-label">INPUT PROMPT</div>
          <pre>{trace.prompt || "N/A"}</pre>
        </div>
        <div className="trace-section">
          <div className="trace-label">MODEL RESPONSE</div>
          <pre>{trace.response || "N/A"}</pre>
        </div>
      </div>
    </details>
  );
}
