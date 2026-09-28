import { type FormEvent, useState } from "react";

interface LoginPageProps {
  onAuthenticated: (authKey: string) => void;
}

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const [authKey, setAuthKey] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = authKey.trim();
    if (!trimmed) {
      setError("Please enter an Auth Key");
      return;
    }
    setIsLoading(true);
    setError("");
    setTimeout(() => {
      setIsLoading(false);
      onAuthenticated(trimmed);
    }, 600);
  }

  return (
    <div className="login-page">
      <div className="login-bg-pattern" />
      <div className="login-card">
        <div className="login-card-top-bar" />
        <div className="login-logo">
          <div className="login-logo-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
          <div className="login-eyebrow">ENTERPRISE AGENT PLATFORM</div>
          <h1 className="login-title">NL2SQL</h1>
          <p className="login-subtitle">Convert Natural Language queries to SQL in real time</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-label" htmlFor="authKey">
            Authentication Key
          </label>
          <input
            id="authKey"
            type="password"
            className="login-input"
            placeholder="Enter your system access key"
            value={authKey}
            onChange={(e) => {
              setAuthKey(e.target.value);
              setError("");
            }}
            autoFocus
          />
          {error && <p className="login-error">{error}</p>}
          <button
            type="submit"
            className="login-btn"
            disabled={isLoading || !authKey.trim()}
          >
            {isLoading ? (
              <span className="login-btn-loading">
                <span className="login-spinner" />
                VERIFYING ACCESS...
              </span>
            ) : (
              "ACCESS DASHBOARD"
            )}
          </button>
        </form>

        <div className="login-footer">
          <span className="login-footer-lock">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </span>
          <span>End-to-end encrypted session · Secure AI query runtime</span>
        </div>
      </div>
    </div>
  );
}
