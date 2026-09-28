import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Load environment variables exclusively from frontend/.env
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
} catch (envError) {
  console.error("Failed to load environment variables from .env:", envError);
}

function devDbMiddlewarePlugin(): Plugin {
  let pool: any = null;

  function getPool() {
    if (pool) return pool;

    try {
      const host = process.env.MYSQL_HOST;
      const portStr = process.env.MYSQL_PORT;
      const user = process.env.MYSQL_USER;
      const password = process.env.MYSQL_PASSWORD;
      const database = process.env.MYSQL_DATABASE;

      if (!host || !user || !database) {
        throw new Error(
          "Missing MySQL configuration in frontend/.env. Ensure MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE are defined."
        );
      }

      const port = portStr ? parseInt(portStr, 10) : 3306;
      if (isNaN(port)) {
        throw new Error(`Invalid MYSQL_PORT in frontend/.env: '${portStr}'`);
      }

      pool = mysql.createPool({
        host,
        port,
        user,
        password: password || "",
        database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        connectTimeout: 30000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
      });

      return pool;
    } catch (poolErr) {
      console.error("Failed to initialize MySQL pool:", poolErr);
      throw poolErr;
    }
  }

  async function resetPool() {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Ignore errors when ending broken sockets
      }
      pool = null;
    }
    return getPool();
  }

  return {
    name: "dev-db-middleware-plugin",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";

        if (url === "/env-config.js" || url.startsWith("/env-config.js?")) {
          const apiBaseUrl = process.env.VITE_API_BASE_URL || "";
          const apiKey = process.env.VITE_API_KEY || "";
          res.writeHead(200, {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-store",
          });
          return res.end(`window.__APP_ENV__ = {
  VITE_API_BASE_URL: ${JSON.stringify(apiBaseUrl)},
  VITE_API_KEY: ${JSON.stringify(apiKey)}
};`);
        }

        if (!url.startsWith("/api/dev-execute-sql") && !url.startsWith("/dev-api/execute-sql")) {
          return next();
        }

        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          return res.end();
        }

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "Method not allowed" }));
        }

        let bodyStr = "";
        req.on("data", (chunk: any) => {
          bodyStr += chunk;
        });

        req.on("end", async () => {
          try {
            let body: any = {};
            try {
              body = JSON.parse(bodyStr || "{}");
            } catch (jsonErr: any) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(
                JSON.stringify({
                  success: false,
                  error: `Invalid JSON payload: ${jsonErr.message}`,
                })
              );
            }

            const sql = body.sql?.trim();
            if (!sql) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(
                JSON.stringify({ success: false, error: "SQL query string is required" })
              );
            }

            // Security guardrail: Read-only SELECT/WITH
            const upper = sql.toUpperCase();
            if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(
                JSON.stringify({
                  success: false,
                  error: "Safety guardrail: Only read-only SELECT or WITH statements are allowed.",
                })
              );
            }

            const timeoutMs = parseInt(process.env.MYSQL_QUERY_TIMEOUT_MS || "60000", 10);
            const dbPool = getPool();
            const startTime = Date.now();
            let rows: any;

            try {
              const [queryRows] = await dbPool.query({ sql, timeout: timeoutMs });
              rows = queryRows;
            } catch (queryErr: any) {
              // If idle connection timed out or socket dropped on remote RDS, reset and retry once
              if (
                queryErr.code === "PROTOCOL_SEQUENCE_TIMEOUT" ||
                queryErr.code === "ECONNRESET" ||
                queryErr.code === "PROTOCOL_CONNECTION_LOST"
              ) {
                console.warn(
                  `[dev-db] Query failed with ${queryErr.code}. Resetting MySQL pool and retrying query...`
                );
                const freshPool = await resetPool();
                const [retryRows] = await freshPool.query({ sql, timeout: timeoutMs });
                rows = retryRows;
              } else {
                throw queryErr;
              }
            }

            const dbLatencyMs = Date.now() - startTime;
            const rowArray = Array.isArray(rows) ? rows : [];

            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            return res.end(
              JSON.stringify({
                success: true,
                rows: rowArray,
                rowCount: rowArray.length,
                dbLatencyMs,
              })
            );
          } catch (err: any) {
            console.error("Vite Dev DB execution error:", err);
            res.writeHead(500, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            return res.end(
              JSON.stringify({
                success: false,
                error:
                  err.code === "PROTOCOL_SEQUENCE_TIMEOUT"
                    ? "Query timed out. The database query exceeded the maximum execution time."
                    : err.message || "Database execution failed",
              })
            );
          }
        });
      });
    },
  };
}

const apiTarget = process.env.VITE_API_BASE_URL;

// Only proxy /api when a backend target is configured. An undefined target
// makes every /api/query fail; in that case relative /api calls resolve
// against vite dev itself (useful with full-URL apiBaseUrl unset is a
// misconfiguration — warn loudly instead of silently proxying nowhere).
if (!apiTarget) {
  console.warn(
    "[vite] VITE_API_BASE_URL is not set — /api/* will NOT be proxied. " +
      "Set frontend/.env VITE_API_BASE_URL to your backend origin."
  );
}

export default defineConfig({
  plugins: [react(), devDbMiddlewarePlugin()],
  server: {
    port: 8080,
    ...(apiTarget
      ? {
          proxy: {
            "/api": {
              target: apiTarget,
              changeOrigin: true,
              bypass(req) {
                // Bypass proxy for frontend dev database execution endpoints
                // so the local dev-db middleware plugin handles them.
                // Returning the URL string serves it locally instead of proxying.
                if (
                  req.url &&
                  (req.url.startsWith("/api/dev-execute-sql") ||
                    req.url.startsWith("/dev-api/execute-sql"))
                ) {
                  return req.url;
                }
                // Also bypass when the backend itself serves dev-execute-sql
                // (server.mjs prod parity) — never proxy local dev DB traffic.
                return undefined;
              },
            },
          },
        }
      : {}),
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
