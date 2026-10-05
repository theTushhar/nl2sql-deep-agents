import { config } from "./config";
import type { QueryResult, DevSqlResult } from "../types";

/**
 * Backend contract (source of truth):
 *   backend/src/api/response-mapper.ts  -> BackendCompatEnvelope
 *   backend/src/api/query-request.schema.ts -> QueryRequestSchema
 *   backend/src/server.ts -> POST /api/query, validation/500 shapes, no auth
 *
 * Success (HTTP 200):
 *   { request_id, thread_id, status: "success",
 *     data: { message, sql, db_neutral_query?, dialect, meta, warnings?, ast, telemetry, echo? } }
 * Blocked / error kind (HTTP 400, same envelope, status "error"):
 *   { request_id, thread_id, status: "error",
 *     data: { message, sql: null, dialect, meta, ast: null, telemetry, ... } }
 * Validation failure (HTTP 400):
 *   { status: "error", error: "Invalid request payload" | "Field 'query' is required.", details? }
 * Server failure (HTTP 500):
 *   { status: "error", error: "Internal server error" }
 *
 * Rules enforced here:
 * - Surface `data.message` on 400 envelope errors (never drop it).
 * - Surface `error` on validation/500 shapes.
 * - Never coerce `warnings` into an error.
 */

function baseHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Backend currently has NO auth (server.ts: "No auth by design").
  // Only attach a key if one is explicitly configured, and use a single
  // header to avoid dual-header drift. Hidden / optional by design.
  const key = config.apiKey;
  if (key) {
    headers["X-API-Key"] = key;
  }
  return headers;
}

/** Extract a human message from a non-2xx /api/query response body. */
export async function parseErrorResponse(response: Response): Promise<string> {
  let errJson: any = null;
  try {
    errJson = await response.json();
  } catch {
    try {
      const errText = await response.text();
      if (errText && errText.length < 500) return errText;
    } catch {
      // ignore
    }
    return "";
  }

  if (!errJson || typeof errJson !== "object") return "";

  // 1. Blocked / error-kind envelope (HTTP 400, status "error"):
  //    { request_id, thread_id, status: "error", data: { message, ... } }
  const dataMessage = errJson?.data?.message;
  if (typeof dataMessage === "string" && dataMessage.trim()) {
    return dataMessage;
  }

  // 2. Validation / 500 shapes: { status: "error", error, details? }
  const errField = errJson?.error;
  if (typeof errField === "string" && errField.trim()) {
    const details = errJson?.details;
    if (typeof details === "string" && details.trim()) {
      return `${errField} — ${details}`;
    }
    return errField;
  }

  // 3. Generic fallbacks (kept for forward-compat only).
  const msg = errJson?.message;
  if (typeof msg === "string" && msg.trim()) return msg;

  return "";
}

export interface QueryPayload {
  /** Natural-language question to synthesize into certified SQL (Required). */
  query?: string;
  /** Target domain ('all_test_sets' pins grid domain, 'default' auto-routes). Default: 'default'. */
  domain?: string;
  /** Target SQL rendering dialect ('mysql' | 'mssql'). Default: 'mysql'. */
  dialect?: string;
  /** Generate AST v2 output. Default: true. */
  include_ast?: boolean;
  /** Generate SQL output. Default: true. */
  include_sql?: boolean;
  /** When true, includes deep per-stage LLM traces in telemetry. Default: false. */
  include_traces?: boolean;
  /** Optional caller request tracking id. Auto-generated if omitted. */
  request_id?: string;
  /** Optional conversation thread/session id. Auto-generated if omitted. */
  thread_id?: string;
  /** Optional user identifier for session and telemetry tracking. */
  user_id?: string;
  /** Optional tenant or execution context filters (echoed back verbatim). */
  context_filters?: Record<string, unknown>;
  /**
   * @deprecated Passthrough only — the backend accepts and echoes `execute`
   * but never executes SQL server-side. Execution happens only via the
   * DEV-only frontend proxy (/api/dev-execute-sql).
   */
  execute?: boolean;
  /** Custom caller passthrough fields (e.g. tenant_id, run_uuid) — echoed in data.echo. */
  [key: string]: unknown;
}

function normalizeEnvelope(json: any, statusCode: number): QueryResult {
  const data = json?.data && typeof json.data === "object" ? json.data : {};
  const meta = data?.meta && typeof data.meta === "object" ? data.meta : undefined;
  const telemetry = data?.telemetry && typeof data.telemetry === "object" ? data.telemetry : undefined;

  return {
    requestId: json?.request_id,
    threadId: json?.thread_id,
    status: json?.status === "error" ? "error" : json?.status === "unsupported" ? "unsupported" : "success",
    statusCode,
    message: typeof data?.message === "string" ? data.message : null,
    sql: typeof data?.sql === "string" ? data.sql : null,
    dbNeutralQuery:
      typeof data?.db_neutral_query === "string" ? data.db_neutral_query : null,
    dialect: typeof data?.dialect === "string" ? data.dialect : undefined,
    warnings: Array.isArray(data?.warnings)
      ? data.warnings.filter((w: unknown): w is string => typeof w === "string")
      : [],
    ast: Object.prototype.hasOwnProperty.call(data, "ast") ? data.ast : null,
    meta: meta
      ? {
          domain: meta.domain,
          intent: meta.intent,
          complexity: meta.complexity,
          tables: Array.isArray(meta.tables) ? meta.tables : undefined,
          unresolved: Array.isArray(meta.unresolved) ? meta.unresolved : undefined,
        }
      : undefined,
    telemetry,
    echo:
      data?.echo && typeof data.echo === "object"
        ? (data.echo as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Execute a natural-language query against POST /api/query.
 * Honors caller-supplied `include_traces` (defaults to false per backend).
 * Throws on non-2xx with the backend's own message surfaced.
 */
export async function executeQuery(payload: QueryPayload): Promise<QueryResult> {
  const body: QueryPayload = {
    domain: "default",
    dialect: "mysql",
    include_traces: false,
    ...payload,
  };

  const response = await fetch(`${config.apiBaseUrl}/api/query`, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Blocked / error-kind envelopes arrive as HTTP 400 WITH a data.message.
    // Try to preserve the full envelope so the UI can still render
    // request_id / telemetry / ast context on errors.
    let raw: any = null;
    try {
      raw = await response.clone().json();
    } catch {
      raw = null;
    }
    if (raw && typeof raw === "object" && raw.data && typeof raw.data === "object") {
      const preserved = normalizeEnvelope(raw, response.status);
      const err = new Error(
        (typeof preserved.message === "string" && preserved.message) ||
          `Backend request failed (${response.status})`,
      );
      (err as Error & { envelope?: QueryResult }).envelope = preserved;
      throw err;
    }
    const errMsg = await parseErrorResponse(response);
    throw new Error(errMsg || `Backend request failed (${response.status})`);
  }

  const json = await response.json();
  // Defensive: backend never sends top-level `error` on 2xx, but if a proxy
  // or gateway does, surface it instead of silently rendering empty state.
  if (json && typeof json === "object" && typeof json.error === "string" && !json.data) {
    throw new Error(json.error);
  }
  return normalizeEnvelope(json, response.status);
}

/** True in local `vite dev` only — false in any `vite build` output. */
export const isDevBuild = (): boolean => import.meta.env.DEV === true;

export async function executeDevSql(sql: string): Promise<DevSqlResult> {
  if (!isDevBuild()) {
    return {
      success: false,
      error:
        "SQL execution is DEV-only (vite dev + /api/dev-execute-sql middleware). This production build has no database proxy — copy the SQL and run it in your own client.",
    };
  }
  try {
    const res = await fetch("/api/dev-execute-sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });

    if (!res.ok) {
      let errMsg = `Database execution failed (${res.status})`;
      // 404 from a prod static server means the dev middleware is absent.
      if (res.status === 404) {
        return {
          success: false,
          error:
            "Dev DB proxy not found (404). Are you running `vite dev`? In production builds SQL execution is disabled.",
        };
      }
      try {
        const json = await res.json();
        if (json.error) errMsg = json.error;
      } catch {
        try {
          const txt = await res.text();
          if (txt) errMsg = txt.slice(0, 500);
        } catch {
          // ignore
        }
      }
      return { success: false, error: errMsg };
    }

    const json = await res.json();
    return json;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Frontend Dev DB execution error: ${msg}`,
    };
  }
}
