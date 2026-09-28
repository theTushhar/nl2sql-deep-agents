import { useCallback, useEffect, useState } from "react";
import { config } from "../lib/config";

export function useApiKey() {
  const [apiKey, setApiKeyState] = useState<string>(() => config.apiKey);

  useEffect(() => {
    setApiKeyState(config.apiKey);
  }, []);

  const setApiKey = useCallback((key: string) => {
    config.setApiKey(key);
    setApiKeyState(key);
  }, []);

  const promptForApiKey = useCallback(() => {
    const entered = prompt("Update Service API Key:", apiKey);
    if (entered !== null) {
      setApiKey(entered.trim());
    }
  }, [apiKey, setApiKey]);

  return {
    apiKey,
    isConfigured: Boolean(apiKey),
    setApiKey,
    promptForApiKey,
  };
}
