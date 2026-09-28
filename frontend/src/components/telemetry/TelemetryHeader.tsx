interface TelemetryHeaderProps {
  showDot?: boolean;
}

export function TelemetryHeader({ showDot = true }: TelemetryHeaderProps) {
  return (
    <div className="telemetry-header">
      <div className="telemetry-eyebrow">
        {showDot && <span className="telemetry-dot" />}
        REALTIME METRICS
      </div>
      <h2>Telemetry</h2>
    </div>
  );
}
