interface NodeStatusProps {
  status: string | null;
}

export function NodeStatus({ status }: NodeStatusProps) {
  if (!status) return null;

  return (
    <div className="node-status-container">
      <div className="node-status-pill">
        <span className="node-status-dot" />
        <span className="node-status-label">PIPELINE ACTIVE</span>
        <span className="node-status-divider">/</span>
        <span className="node-status-text">{status}</span>
      </div>
    </div>
  );
}
