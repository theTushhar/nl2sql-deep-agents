import { useState } from "react";
import { useClipboard } from "../../hooks/useClipboard";

interface AstViewerProps {
  ast: unknown | null | undefined;
  status?: string;
}

/** Null AST is expected for conversational / blocked / error turns. */
function NullAstNote({ status }: { status?: string }) {
  return (
    <div className="inspector-empty">
      <p>
        No AST for this response
        {status ? ` (status: ${status})` : ""}. AST is only present for
        certified queries; conversational, blocked, and error turns return{" "}
        <code>ast: null</code>.
      </p>
    </div>
  );
}

function AstNode({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isObject = value !== null && typeof value === "object";
  const childCount = isObject ? Object.keys(value as Record<string, unknown>).length : 0;

  if (!isObject) {
    return (
      <div className="ast-node" style={{ marginLeft: depth * 12 }}>
        <span className="ast-key">{name}</span>
        <span className="ast-sep">: </span>
        <span className="ast-leaf">{JSON.stringify(value)}</span>
      </div>
    );
  }

  if (childCount === 0) {
    return (
      <div className="ast-node" style={{ marginLeft: depth * 12 }}>
        <span className="ast-key">{name}</span>
        <span className="ast-sep">: </span>
        <span className="ast-leaf">{Array.isArray(value) ? "[]" : "{}"}</span>
      </div>
    );
  }

  return (
    <div className="ast-branch" style={{ marginLeft: depth * 12 }}>
      <button
        type="button"
        className="ast-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="summary-indicator">{open ? "▾" : "▸"}</span>
        <span className="ast-key">{name}</span>
        <span className="ast-count">
          {Array.isArray(value) ? `[${childCount}]` : `{${childCount}}`}
        </span>
      </button>
      {open && (
        <div className="ast-children">
          {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
            <AstNode
              key={k}
              name={Array.isArray(value) ? `[${k}]` : k}
              value={v}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function AstViewer({ ast, status }: AstViewerProps) {
  const [showRaw, setShowRaw] = useState(false);
  const { copied, copy } = useClipboard();

  if (ast === null || ast === undefined) {
    return <NullAstNote status={status} />;
  }

  const topKeys =
    ast !== null && typeof ast === "object" ? Object.keys(ast as Record<string, unknown>) : [];

  return (
    <div className="ast-viewer">
      <div className="inspector-bar">
        <span className="response-status-label">
          AST
          {topKeys.length > 0 && (
            <span className="tab-pill-badge"> {topKeys.length} top-level keys</span>
          )}
        </span>
        <div className="inspector-actions">
          <button
            type="button"
            className="btn-text-action"
            onClick={() => setShowRaw((s) => !s)}
            title="Toggle raw AST JSON"
          >
            {showRaw ? "Tree" : "Raw JSON"}
          </button>
          <button
            type="button"
            className="btn-text-action"
            onClick={() => copy(JSON.stringify(ast, null, 2))}
            title="Copy AST JSON"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
      {showRaw ? (
        <div className="json-editor-wrap">
          <pre className="json-pre">{JSON.stringify(ast, null, 2)}</pre>
        </div>
      ) : (
        <div className="ast-tree">
          {topKeys.length === 0 ? (
            <div className="ast-node">
              <span className="ast-leaf">{JSON.stringify(ast)}</span>
            </div>
          ) : (
            Object.entries(ast as Record<string, unknown>).map(([k, v]) => (
              <AstNode key={k} name={k} value={v} depth={0} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
