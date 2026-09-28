import { useCallback } from "react";
import { executeQuery, type QueryPayload } from "../lib/api";
import { STATUS_MESSAGES } from "../lib/constants";
import type { QueryResult, Telemetry } from "../types";
import { SqlExecutionCard } from "../components/chat/SqlExecutionCard";

interface UseQueryExecutionParams {
  addMessage: (type: "user" | "system" | "error", content: React.ReactNode) => void;
  setTelemetry: (telemetry: Telemetry | undefined) => void;
  resetTelemetry: () => void;
  setNodeStatus: (status: string | null) => void;
  setLastRequestPayload: (payload: QueryPayload) => void;
  setLastResponsePayload: (payload: QueryResult | null) => void;
  onOpenInRunner?: (sql: string) => void;
  setLastGeneratedSql?: (sql: string) => void;
}

export interface ExecuteOptions {
  domain: string;
  dialect: string;
  includeTraces: boolean;
  customPayload: QueryPayload | null;
}

function errorEnvelope(err: unknown): QueryResult | null {
  if (err && typeof err === "object" && "envelope" in err) {
    const envelope = (err as { envelope?: unknown }).envelope;
    if (envelope && typeof envelope === "object") return envelope as QueryResult;
  }
  return null;
}

export function useQueryExecution({
  addMessage,
  setTelemetry,
  resetTelemetry,
  setNodeStatus,
  setLastRequestPayload,
  setLastResponsePayload,
  onOpenInRunner,
  setLastGeneratedSql,
}: UseQueryExecutionParams) {
  const execute = useCallback(
    async (question: string, opts: ExecuteOptions) => {
      const { domain, dialect, includeTraces, customPayload } = opts;
      // Custom-payload edit mode wins verbatim, but toggles still provide
      // sane defaults for fields the custom JSON omits.
      const payload: QueryPayload = customPayload
        ? {
            domain: domain || "default",
            dialect: dialect || "mysql",
            include_traces: includeTraces,
            ...customPayload,
            query: customPayload.query || question,
          }
        : {
            query: question,
            domain: domain || "default",
            dialect: dialect || "mysql",
            include_traces: includeTraces,
          };

      const displayedQuestion = (payload.query as string) || question;
      addMessage("user", displayedQuestion);
      setNodeStatus(STATUS_MESSAGES.CONNECTING);
      resetTelemetry();
      setLastRequestPayload(payload);

      try {
        setNodeStatus(STATUS_MESSAGES.SYNTHESIZING);
        const data = await executeQuery(payload);
        setNodeStatus(null);
        setLastResponsePayload(data);

        setTelemetry(data.telemetry);

        // Warnings are informational — never rendered as errors.
        if (data.warnings && data.warnings.length > 0) {
          addMessage(
            "system",
            <div className="answer-text answer-warnings">
              {data.warnings.map((w, i) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>,
          );
        }

        if (data.sql) {
          if (setLastGeneratedSql) {
            setLastGeneratedSql(data.sql);
          }
          addMessage(
            "system",
            <SqlExecutionCard
              initialSql={data.sql}
              onOpenInRunner={onOpenInRunner}
            />,
          );
        }

        // data.message is the human-readable answer for every kind:
        // success (incl. conversational sql=null), blocked, error.
        const message = data.message?.trim() || "";
        if (data.status === "error") {
          addMessage(
            "system",
            <div className="answer-text">{message || "The request was blocked."}</div>,
          );
        } else if (message && !data.sql) {
          // Conversational turn (sql: null, ast: null) — show the reply text.
          addMessage("system", <div className="answer-text">{message}</div>);
        } else if (!data.sql && !message) {
          addMessage("system", <div className="answer-text">No SQL query was generated for this input.</div>);
        }
      } catch (err) {
        const preserved = errorEnvelope(err);
        if (preserved) {
          setLastResponsePayload(preserved);
          setTelemetry(preserved.telemetry);
        } else {
          const message =
            err instanceof Error ? err.message : "An unexpected error occurred.";
          setLastResponsePayload({ error: message });
        }
        const message =
          err instanceof Error ? err.message : "An unexpected error occurred.";
        setNodeStatus(null);
        addMessage("error", `Error: ${message}`);
      } finally {
        setNodeStatus(null);
      }
    },
    [addMessage, setTelemetry, resetTelemetry, setNodeStatus, setLastRequestPayload, setLastResponsePayload, onOpenInRunner, setLastGeneratedSql],
  );

  return { execute };
}
