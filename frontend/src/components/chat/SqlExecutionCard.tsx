import { useState, useCallback } from "react";
import { executeDevSql, isDevBuild } from "../../lib/api";
import { useClipboard } from "../../hooks/useClipboard";
import { DataTable } from "./DataTable";

const IS_DEV = isDevBuild();

interface SqlExecutionCardProps {
  initialSql: string;
  onOpenInRunner?: (sql: string) => void;
}

export function SqlExecutionCard({
  initialSql,
  onOpenInRunner,
}: SqlExecutionCardProps) {
  const [sql, setSql] = useState(initialSql);
  const [isEditing, setIsEditing] = useState(false);
  const [status, setStatus] = useState<"idle" | "executing" | "success" | "skipped" | "error">("idle");
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const { copied, copy } = useClipboard(1800);

  const handleCopy = () => copy(sql);

  const handleExecute = useCallback(async () => {
    const queryToRun = sql.trim();
    if (!queryToRun) return;

    setStatus("executing");
    setErrorMsg(null);

    const res = await executeDevSql(queryToRun);

    if (res.success) {
      setRows(res.rows || []);
      setLatencyMs(res.dbLatencyMs ?? null);
      setStatus("success");
    } else {
      setErrorMsg(res.error || "Execution failed against Dev DB");
      setStatus("error");
    }
  }, [sql]);

  const handleSkip = useCallback(() => {
    setStatus("skipped");
  }, []);

  const handleResetSql = useCallback(() => {
    setSql(initialSql);
    setIsEditing(false);
  }, [initialSql]);

  return (
    <div className="sql-execution-card">
      <div className="sql-card-header">
        <div className="sql-card-title-group">
          <span className="sql-indicator" />
          <span className="sql-label">GENERATED SQL</span>
          {sql !== initialSql && (
            <span className="sql-edited-badge">EDITED</span>
          )}
        </div>
        <div className="sql-card-header-actions">
          <button
            type="button"
            className={`sql-action-btn ${isEditing ? "active" : ""}`}
            onClick={() => setIsEditing(!isEditing)}
            title={isEditing ? "Done editing" : "Edit SQL"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span>{isEditing ? "VIEW" : "EDIT"}</span>
          </button>

          {isEditing && sql !== initialSql && (
            <button
              type="button"
              className="sql-action-btn"
              onClick={handleResetSql}
              title="Reset to original generated SQL"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              <span>RESET</span>
            </button>
          )}

          {onOpenInRunner && (
            <button
              type="button"
              className="sql-action-btn"
              onClick={() => onOpenInRunner(sql)}
              title="Open in Sidebar SQL Runner"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
              <span>RUNNER</span>
            </button>
          )}

          <button
            type="button"
            className="sql-copy-btn"
            onClick={handleCopy}
            title="Copy SQL to clipboard"
          >
            {copied ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>COPIED</span>
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>COPY</span>
              </>
            )}
          </button>
        </div>
      </div>

      {isEditing ? (
        <div className="sql-editor-container">
          <textarea
            className="sql-editor-textarea"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={Math.max(4, sql.split("\n").length + 1)}
            spellCheck={false}
            placeholder="Enter SQL SELECT statement..."
          />
        </div>
      ) : (
        <pre className="sql-code"><code>{sql}</code></pre>
      )}

      {/* Confirmation & Actions Bar */}
      {status === "idle" && (
        IS_DEV ? (
          <div className="sql-confirmation-bar">
            <div className="sql-confirmation-prompt">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span>Execute this query in the Dev DB? (DEV-only)</span>
            </div>
            <div className="sql-confirmation-actions">
              <button
                type="button"
                className="btn-sql-confirm"
                onClick={handleExecute}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                <span>EXECUTE IN DEV DB</span>
              </button>
              <button
                type="button"
                className="btn-sql-skip"
                onClick={handleSkip}
              >
                <span>SKIP</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="sql-status-bar sql-skipped-bar">
            <div className="sql-status-info">
              <span className="sql-skipped-tag">PROD BUILD</span>
              <span>SQL execution is DEV-only. Copy the SQL and run it in your own client.</span>
            </div>
          </div>
        )
      )}

      {status === "skipped" && (
        <div className="sql-status-bar sql-skipped-bar">
          <div className="sql-status-info">
            <span className="sql-skipped-tag">SKIPPED</span>
            <span>Query not executed in DB. You can run it whenever you're ready.</span>
          </div>
          <button
            type="button"
            className="btn-sql-run-mini"
            onClick={handleExecute}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            <span>RUN IN DEV DB</span>
          </button>
        </div>
      )}

      {status === "executing" && (
        <div className="sql-status-bar sql-executing-bar">
          <span className="sql-spinner" />
          <span>Executing query in frontend Dev DB...</span>
        </div>
      )}

      {status === "success" && (
        <div className="sql-result-container">
          <div className="sql-status-bar sql-success-bar">
            <div className="sql-status-info">
              <span className="sql-success-badge">EXECUTED</span>
              {latencyMs != null && (
                <span className="sql-meta-badge">{latencyMs}ms</span>
              )}
              {rows && (
                <span className="sql-meta-badge">
                  {rows.length} {rows.length === 1 ? "row" : "rows"}
                </span>
              )}
            </div>
            <button
              type="button"
              className="btn-sql-rerun"
              onClick={handleExecute}
              title="Re-run query directly against Dev DB"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
              <span>RE-RUN</span>
            </button>
          </div>

          {rows && rows.length > 0 ? (
            <DataTable rows={rows} />
          ) : (
            <div className="sql-empty-result">
              Query executed successfully (0 rows returned).
            </div>
          )}
        </div>
      )}

      {status === "error" && (
        <div className="sql-result-container">
          <div className="sql-error-box">
            <div className="sql-error-header">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <strong>Frontend Dev DB Execution Error:</strong>
            </div>
            <div className="sql-error-msg">{errorMsg}</div>
            <div className="sql-error-actions">
              <button
                type="button"
                className="btn-sql-retry"
                onClick={handleExecute}
              >
                <span>RETRY QUERY</span>
              </button>
              <button
                type="button"
                className="btn-sql-edit-prompt"
                onClick={() => setIsEditing(true)}
              >
                <span>EDIT SQL</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
