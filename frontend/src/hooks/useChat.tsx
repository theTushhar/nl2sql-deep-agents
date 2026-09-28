import { useCallback, useState } from "react";
import type { QueryPayload } from "../lib/api";
import {
  DEFAULT_DIALECT,
  DEFAULT_DOMAIN,
  DEFAULT_INCLUDE_TRACES,
  STORAGE_KEYS,
} from "../lib/constants";
import type { SidebarTab } from "../components/telemetry/TelemetrySidebar";
import type { QueryResult } from "../types";
import { useChatMessages } from "./useChatMessages";
import { useTelemetry } from "./useTelemetry";
import { useQueryExecution } from "./useQueryExecution";

function readStored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function readStoredBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable
  }
}

export function useChat() {
  const { messages, addMessage } = useChatMessages();
  const { telemetry, setTelemetry, resetTelemetry } = useTelemetry();

  const [isStreaming, setIsStreaming] = useState(false);
  const [nodeStatus, setNodeStatus] = useState<string | null>(null);
  const [selectedDomain, setSelectedDomainState] = useState<string>(() =>
    readStored(STORAGE_KEYS.DOMAIN, DEFAULT_DOMAIN),
  );
  const [selectedDialect, setSelectedDialectState] = useState<string>(() =>
    readStored(STORAGE_KEYS.DIALECT, DEFAULT_DIALECT),
  );
  const [includeTraces, setIncludeTracesState] = useState<boolean>(() =>
    readStoredBool(STORAGE_KEYS.INCLUDE_TRACES, DEFAULT_INCLUDE_TRACES),
  );
  const [customPayload, setCustomPayload] = useState<QueryPayload | null>(null);
  const [lastRequestPayload, setLastRequestPayload] = useState<QueryPayload>({
    query: "",
    domain: DEFAULT_DOMAIN,
    dialect: DEFAULT_DIALECT,
    include_traces: DEFAULT_INCLUDE_TRACES,
  });
  const [lastResponsePayload, setLastResponsePayload] = useState<QueryResult | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("telemetry");
  const [lastGeneratedSql, setLastGeneratedSql] = useState<string | null>(null);
  const [activeSqlRunnerQuery, setActiveSqlRunnerQuery] = useState<string | null>(null);

  const setSelectedDomain = useCallback((domain: string) => {
    setSelectedDomainState(domain);
    writeStored(STORAGE_KEYS.DOMAIN, domain);
  }, []);

  const setSelectedDialect = useCallback((dialect: string) => {
    setSelectedDialectState(dialect);
    writeStored(STORAGE_KEYS.DIALECT, dialect);
  }, []);

  const setIncludeTraces = useCallback((value: boolean) => {
    setIncludeTracesState(value);
    writeStored(STORAGE_KEYS.INCLUDE_TRACES, String(value));
  }, []);

  const openInSqlRunner = useCallback((sql: string) => {
    setActiveSqlRunnerQuery(sql);
    setSidebarTab("sql-runner");
  }, []);

  const { execute } = useQueryExecution({
    addMessage,
    setTelemetry,
    resetTelemetry,
    setNodeStatus,
    setLastRequestPayload,
    setLastResponsePayload,
    onOpenInRunner: openInSqlRunner,
    setLastGeneratedSql,
  });

  const sendQuestion = useCallback(
    async (question: string) => {
      setIsStreaming(true);
      try {
        await execute(question, {
          domain: selectedDomain,
          dialect: selectedDialect,
          includeTraces,
          customPayload,
        });
      } finally {
        setIsStreaming(false);
      }
    },
    [execute, selectedDomain, selectedDialect, includeTraces, customPayload],
  );

  return {
    messages,
    isStreaming,
    nodeStatus,
    telemetry,
    sendQuestion,
    selectedDomain,
    setSelectedDomain,
    selectedDialect,
    setSelectedDialect,
    includeTraces,
    setIncludeTraces,
    customPayload,
    setCustomPayload,
    lastRequestPayload,
    lastResponsePayload,
    sidebarTab,
    setSidebarTab,
    lastGeneratedSql,
    activeSqlRunnerQuery,
    openInSqlRunner,
  };
}
