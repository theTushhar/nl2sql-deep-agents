import { STORAGE_KEYS } from "./constants";

function getStoredValue(key: string): string {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function setStoredValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable
  }
}

function resolveConfigValue(
  paramNames: string[],
  storageKey: string,
  envKey: string,
): string {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    for (const name of paramNames) {
      const paramValue = urlParams.get(name);
      if (paramValue) {
        setStoredValue(storageKey, paramValue);
        return paramValue;
      }
    }

    const storedValue = getStoredValue(storageKey);
    if (storedValue) return storedValue;

    // Check runtime environment injected from Kubernetes ConfigMap / server.mjs
    const runtimeValue = (typeof window !== "undefined" && (window as any).__APP_ENV__)?.[envKey];
    if (runtimeValue) return runtimeValue;

    const envValue = (import.meta as any).env?.[envKey];
    if (envValue) return envValue;

    return "";
  } catch (err) {
    console.error(`Failed to resolve config value for ${storageKey}:`, err);
    return "";
  }
}

function resolveApiBaseUrl(): string {
  return resolveConfigValue(
    ["apiUrl", "backend"],
    STORAGE_KEYS.API_BASE_URL,
    "VITE_API_BASE_URL",
  );
}

function resolveApiKey(): string {
  return resolveConfigValue(
    ["apiKey", "key"],
    STORAGE_KEYS.API_KEY,
    "VITE_API_KEY",
  );
}

export const config = {
  get apiBaseUrl() {
    return resolveApiBaseUrl();
  },
  get apiKey() {
    return resolveApiKey();
  },
  setApiKey(key: string) {
    setStoredValue(STORAGE_KEYS.API_KEY, key);
  },
};
