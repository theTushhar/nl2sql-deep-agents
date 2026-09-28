import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env strictly from frontend/.env inside try-catch
try {
  const localEnvPath = path.resolve(__dirname, ".env");
  if (fs.existsSync(localEnvPath)) {
    dotenv.config({ path: localEnvPath });
  } else {
    dotenv.config();
  }
} catch (err) {
  console.error("Failed to load .env in dev-proxy:", err);
}

const PORT = parseInt(process.env.DEV_PROXY_PORT || "8082", 10);
const MYSQL_HOST = process.env.MYSQL_HOST;
const MYSQL_PORT = process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT, 10) : 3306;
const MYSQL_USER = process.env.MYSQL_USER;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || "";
const MYSQL_DATABASE = process.env.MYSQL_DATABASE;

let pool = null;

function getPool() {
  if (pool) return pool;

  if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_DATABASE) {
    throw new Error(
      "Missing MySQL configuration in .env. Ensure MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE are defined."
    );
  }

  try {
    pool = mysql.createPool({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 30000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
    return pool;
  } catch (err) {
    console.error("Failed to create MySQL pool in dev-proxy:", err);
    throw err;
  }
}

async function resetPool() {
  if (pool) {
    try {
      await pool.end();
    } catch {
      // Ignore errors closing dead sockets
    }
    pool = null;
  }
  return getPool();
}

function sendJson(res, statusCode, data) {
  try {
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    });
    res.end(JSON.stringify(data));
  } catch (err) {
    console.error("Error sending JSON response:", err);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
      });
      return res.end();
    }

    const hostHeader = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url, `http://${hostHeader}`);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
      try {
        const activePool = getPool();
        await activePool.query("SELECT 1");
        return sendJson(res, 200, {
          status: "running",
          port: PORT,
          database: "connected",
          host: MYSQL_HOST,
          dbName: MYSQL_DATABASE,
        });
      } catch (err) {
        return sendJson(res, 503, {
          status: "degraded",
          port: PORT,
          database: "disconnected",
          error: err.message,
        });
      }
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/api/dev-execute-sql" || url.pathname === "/dev-api/execute-sql")
    ) {
      let bodyStr = "";
      req.on("data", (chunk) => {
        bodyStr += chunk;
      });

      req.on("end", async () => {
        try {
          let body = {};
          try {
            body = JSON.parse(bodyStr || "{}");
          } catch (jsonErr) {
            return sendJson(res, 400, {
              success: false,
              error: `Invalid JSON payload: ${jsonErr.message}`,
            });
          }

          const sql = body.sql?.trim();
          if (!sql) {
            return sendJson(res, 400, { success: false, error: "SQL query string is required" });
          }

          // Security check: Only allow read-only queries (SELECT or WITH)
          const upper = sql.toUpperCase();
          if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
            return sendJson(res, 400, {
              success: false,
              error: "Dev proxy safety guardrail: Only SELECT/WITH read-only queries are permitted.",
            });
          }

          const forbiddenKeywords = [
            "INSERT ",
            "UPDATE ",
            "DELETE ",
            "DROP ",
            "ALTER ",
            "TRUNCATE ",
            "EXEC ",
          ];
          for (const kw of forbiddenKeywords) {
            if (upper.includes(kw)) {
              return sendJson(res, 400, {
                success: false,
                error: `Dev proxy safety guardrail: Forbidden keyword '${kw.trim()}' detected.`,
              });
            }
          }

          const timeoutMs = parseInt(process.env.MYSQL_QUERY_TIMEOUT_MS || "60000", 10);
          const activePool = getPool();
          const startTime = Date.now();
          let rows;

          try {
            const [queryRows] = await activePool.query({ sql, timeout: timeoutMs });
            rows = queryRows;
          } catch (queryErr) {
            if (
              queryErr.code === "PROTOCOL_SEQUENCE_TIMEOUT" ||
              queryErr.code === "ECONNRESET" ||
              queryErr.code === "PROTOCOL_CONNECTION_LOST"
            ) {
              console.warn(
                `[dev-proxy] Query failed with ${queryErr.code}. Resetting MySQL pool and retrying...`
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
          return sendJson(res, 200, {
            success: true,
            rows: rowArray,
            rowCount: rowArray.length,
            dbLatencyMs,
          });
        } catch (err) {
          console.error("Dev SQL execution error:", err);
          return sendJson(res, 500, {
            success: false,
            error:
              err.code === "PROTOCOL_SEQUENCE_TIMEOUT"
                ? "Query timed out. The database query exceeded the maximum execution time."
                : err.message || "Database execution failed",
          });
        }
      });
      return;
    }

    sendJson(res, 404, { success: false, error: "Not found" });
  } catch (serverErr) {
    console.error("Unhandled server error in dev-proxy:", serverErr);
    sendJson(res, 500, { success: false, error: "Internal server error" });
  }
});

try {
  server.listen(PORT, () => {
    console.log(`[Frontend Dev DB Proxy] running on http://localhost:${PORT}`);
    if (MYSQL_HOST && MYSQL_USER && MYSQL_DATABASE) {
      console.log(
        `[Frontend Dev DB Proxy] Configured with MySQL: ${MYSQL_USER}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}`
      );
    } else {
      console.warn(
        `[Frontend Dev DB Proxy] Warning: MySQL environment variables are not fully configured in .env`
      );
    }
  });
} catch (listenErr) {
  console.error("Failed to bind server to port:", listenErr);
}
