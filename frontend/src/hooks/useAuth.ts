import { useCallback, useState } from "react";
import { STORAGE_KEYS } from "../lib/constants";

function getStoredAuth(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.AUTHENTICATED) === "true";
  } catch {
    return false;
  }
}

export function useAuth() {
  const [authenticated, setAuthenticated] = useState(getStoredAuth);

  const handleAuthenticated = useCallback((authKey: string) => {
    try {
      localStorage.setItem(STORAGE_KEYS.AUTHENTICATED, "true");
      localStorage.setItem(STORAGE_KEYS.AUTH_KEY, authKey);
    } catch {
      // ignore
    }
    setAuthenticated(true);
  }, []);

  const handleLogout = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEYS.AUTHENTICATED);
      localStorage.removeItem(STORAGE_KEYS.AUTH_KEY);
    } catch {
      // ignore
    }
    setAuthenticated(false);
  }, []);

  return { authenticated, handleAuthenticated, handleLogout };
}
