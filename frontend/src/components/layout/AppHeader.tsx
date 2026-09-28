interface AppHeaderProps {
  isApiKeyConfigured: boolean;
  onApiKeyClick: () => void;
  onLogout: () => void;
}

export function AppHeader({ isApiKeyConfigured, onApiKeyClick, onLogout }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="header-top-accent" />
      <div className="header-inner">
        <div className="header-titles">
          <div className="header-logo-row">
            <div className="header-logo-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7V4h3" />
                <path d="M4 17v3h3" />
                <path d="M20 7V4h-3" />
                <path d="M20 17v3h-3" />
                <path d="M7 4h10" />
                <path d="M7 20h10" />
                <path d="M4 12h16" />
                <path d="M9 8l3 4-3 4" />
                <path d="M15 8l-3 4 3 4" />
              </svg>
            </div>
            <div className="header-brand-wrap">
              <h1>NL2SQL</h1>
              <span className="header-badge">AI AGENT</span>
            </div>
          </div>
          <div className="header-divider" />
          <p className="subtitle">Natural Language to SQL Intelligence</p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={`btn-api-key ${isApiKeyConfigured ? "configured" : ""}`}
            title="Optional: backend currently requires no auth. When set, sent as single X-API-Key header."
            onClick={onApiKeyClick}
          >
            <span className={`status-indicator-dot ${isApiKeyConfigured ? "dot-active" : ""}`} />
            <span>{isApiKeyConfigured ? "KEY ACTIVE" : "SET KEY"}</span>
          </button>
          <button
            type="button"
            className="btn-logout"
            title="Logout"
            onClick={onLogout}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>LOGOUT</span>
          </button>
        </div>
      </div>
    </header>
  );
}
