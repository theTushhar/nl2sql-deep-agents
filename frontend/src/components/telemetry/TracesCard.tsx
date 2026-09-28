import type { LlmTrace } from "../../types";
import { TraceItem } from "./TraceItem";

interface TracesCardProps {
  traces: LlmTrace[];
}

export function TracesCard({ traces }: TracesCardProps) {
  return (
    <div className="telemetry-card traces-card">
      <div className="card-header-bar">
        <span className="card-eyebrow">EXECUTION TRACES</span>
        <span className="card-count-pill">{traces.length} CALLS</span>
      </div>
      <div className="traces-list">
        {traces.map((trace, index) => (
          <TraceItem key={index} index={index} trace={trace} />
        ))}
      </div>
    </div>
  );
}
