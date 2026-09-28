import { useClipboard } from "../../hooks/useClipboard";

interface SqlBlockProps {
  sql: string;
}

export function SqlBlock({ sql }: SqlBlockProps) {
  const { copied, copy } = useClipboard(1800);

  const handleCopy = () => copy(sql);

  return (
    <div className="sql-block">
      <div className="sql-block-header">
        <div className="sql-block-title">
          <span className="sql-indicator" />
          <span className="sql-label">GENERATED SQL</span>
        </div>
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
      <pre className="sql-code"><code>{sql}</code></pre>
    </div>
  );
}
