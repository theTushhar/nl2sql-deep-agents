import { useState } from "react";
import { useClipboard } from "../../hooks/useClipboard";
import type { QueryResult } from "../../types";
import { AstViewer } from "./AstViewer";

interface ResponseBodyViewerProps {
  response: QueryResult | null | undefined;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <details className="trace-details" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="summary-indicator">{open ? "▾" : "▸"}</span>
        <span className="summary-title">{title}</span>
      </summary>
      <div className="trace-content">{children}</div>
    </details>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="stat-row">
      <span className="stat-label">{k}</span>
      <span className="stat-value font-mono">{v}</span>
    </div>
  );
}

export function ResponseBodyViewer({ response }: ResponseBodyViewerProps) {
  const [view, setView] = useState<"parsed" | "raw">("parsed");
  const { copied, copy } = useClipboard();

  if (!response) {
    return (
      <div className="inspector-empty">
        <p>Execute a query or generate SQL to inspect the raw response payload.</p>
      </div>
    );
  }

  // executeQuery always normalizes to QueryResult; { error } alone is the
  // transport-level shape (validation 400 / 500).
  const r = response as QueryResult;
  const rawJson = JSON.stringify(response, null, 2);

  const statusLabel =
    r.statusCode != null
      ? `${r.statusCode} ${r.status === "error" ? "ERROR" : "OK"}`
      : (r.status === "error" ? "ERROR" : r.status === "success" ? "OK" : "UNKNOWN");

  return (
    <div className="response-body-viewer">
      <div className="inspector-bar">
        <span className="response-status-label">
          Latest Response Payload <span className="tab-pill-badge success">{statusLabel}</span>
        </span>
        <div className="inspector-actions">
          <button
            type="button"
            className={`btn-text-action ${view === "parsed" ? "active" : ""}`}
            onClick={() => setView("parsed")}
            title="Parsed field view"
          >
            Parsed
          </button>
          <button
            type="button"
            className={`btn-text-action ${view === "raw" ? "active" : ""}`}
            onClick={() => setView("raw")}
            title="Raw pretty-printed JSON"
          >
            Raw JSON
          </button>
          <button
            type="button"
            className="btn-text-action"
            onClick={() => copy(rawJson)}
            title="Copy full response JSON"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      {view === "raw" ? (
        <div className="json-editor-wrap">
          <pre className="json-pre">{rawJson}</pre>
        </div>
      ) : (
        <div className="response-parsed">
          {r.error && !r.message && !r.sql ? (
            <Section title="TRANSPORT ERROR">
              <div className="sql-error-msg">{r.error}</div>
            </Section>
          ) : (
            <>
              <div className="telemetry-card">
                <div className="card-header-bar">
                  <span className="card-eyebrow">ENVELOPE</span>
                </div>
                <Kv k="status" v={r.status ?? "—"} />
                {r.statusCode != null && <Kv k="http" v={String(r.statusCode)} />}
                {r.requestId && <Kv k="request_id" v={r.requestId} />}
                {r.threadId && <Kv k="thread_id" v={r.threadId} />}
                {r.dialect && <Kv k="dialect" v={r.dialect} />}
              </div>

              <Section title="MESSAGE">
                <pre>{r.message ?? "null"}</pre>
              </Section>

              <Section title="SQL">
                <pre>{r.sql ?? "null"}</pre>
              </Section>

              {r.dbNeutralQuery != null && (
                <Section title="DB-NEUTRAL QUERY">
                  <pre>{r.dbNeutralQuery}</pre>
                </Section>
              )}

              <Section title="AST">
                <AstViewer ast={r.ast} status={r.status} />
              </Section>

              <Section title="META">
                <pre>{JSON.stringify(r.meta ?? null, null, 2)}</pre>
              </Section>

              {r.warnings && r.warnings.length > 0 && (
                <Section title={`WARNINGS (${r.warnings.length})`}>
                  {r.warnings.map((w, i) => (
                    <div key={i} className="sql-error-msg">⚠ {w}</div>
                  ))}
                </Section>
              )}

              <Section title="TELEMETRY">
                <pre>{JSON.stringify(r.telemetry ?? null, null, 2)}</pre>
              </Section>

              {r.echo && Object.keys(r.echo).length > 0 && (
                <Section title="ECHO (passthrough)">
                  <pre>{JSON.stringify(r.echo, null, 2)}</pre>
                </Section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
