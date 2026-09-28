import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || "8080", 10);
const DIST_DIR = path.join(__dirname, "dist");
const QUERY_TIMEOUT_MS = parseInt(process.env.MYSQL_QUERY_TIMEOUT_MS || "60000", 10);

let pool = null;

function getPool() {
  if (pool) return pool;

  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const database = process.env.MYSQL_DATABASE;
  const password = process.env.MYSQL_PASSWORD || "";
  const port = parseInt(process.env.MYSQL_PORT || "3306", 10);

  if (!host || !user || !database) {
    throw new Error(
      "MySQL is not configured in pod environment. Ensure MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE are provided in ConfigMap/Secret."
    );
  }

  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 30000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });

  return pool;
}

async function resetPool() {
  if (pool) {
    try {
      await pool.end();
    } catch {
      // Ignore cleanup error on broken socket
    }
    pool = null;
  }
  return getPool();
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    });
    return res.end();
  }

  const hostHeader = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url, `http://${hostHeader}`);

  // 1. Dynamic Environment Configuration Script
  // Injected directly from Kubernetes ConfigMap/Secret into the browser
  if (req.method === "GET" && url.pathname === "/env-config.js") {
    const apiBaseUrl = process.env.VITE_API_BASE_URL || "";
    const apiKey = process.env.VITE_API_KEY || "";
    const script = `window.__APP_ENV__ = {
  VITE_API_BASE_URL: ${JSON.stringify(apiBaseUrl)},
  VITE_API_KEY: ${JSON.stringify(apiKey)}
};`;
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    return res.end(script);
  }

  // 2. Health Probes
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
    let dbStatus = "unconfigured";
    if (process.env.MYSQL_HOST) {
      try {
        const activePool = getPool();
        await activePool.query("SELECT 1");
        dbStatus = "connected";
      } catch (dbErr) {
        dbStatus = `error: ${dbErr.message}`;
      }
    }
    return sendJson(res, 200, {
      status: "healthy",
      service: "infoqa-query-ai-frontend",
      database: dbStatus,
      port: PORT,
    });
  }

  // 3. Database Execution API
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

        // Security Guardrail: Read-only SELECT or WITH only
        const upper = sql.toUpperCase();
        if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
          return sendJson(res, 400, {
            success: false,
            error: "Safety guardrail: Only read-only SELECT or WITH statements are allowed.",
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
              error: `Safety guardrail: Forbidden keyword '${kw.trim()}' detected.`,
            });
          }
        }

        const activePool = getPool();
        const startTime = Date.now();
        let rows;

        try {
          const [queryRows] = await activePool.query({ sql, timeout: QUERY_TIMEOUT_MS });
          rows = queryRows;
        } catch (queryErr) {
          if (
            queryErr.code === "PROTOCOL_SEQUENCE_TIMEOUT" ||
            queryErr.code === "ECONNRESET" ||
            queryErr.code === "PROTOCOL_CONNECTION_LOST"
          ) {
            console.warn(`[server] Query failed with ${queryErr.code}. Resetting MySQL pool and retrying...`);
            const freshPool = await resetPool();
            const [retryRows] = await freshPool.query({ sql, timeout: QUERY_TIMEOUT_MS });
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
        console.error("Database execution error:", err);
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

  // 4. Static File Serving (SPA Fallback)
  if (req.method === "GET" || req.method === "HEAD") {
    let cleanPath = decodeURIComponent(url.pathname);
    let filePath = path.join(DIST_DIR, cleanPath === "/" ? "index.html" : cleanPath);

    // Security check: prevent directory traversal
    if (!filePath.startsWith(DIST_DIR)) {
      return sendJson(res, 403, { error: "Forbidden" });
    }

    // SPA fallback: if file does not exist, serve index.html
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST_DIR, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const isHtml = ext === ".html";

    // Set cache headers: HTML is never cached; assets with hash can be cached long-term
    const headers = {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    };

    if (isHtml) {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    } else {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Not Found");
      }
      res.writeHead(200, headers);
      res.end(content);
    });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Frontend Pod Server] listening on http://0.0.0.0:${PORT}`);
  if (process.env.MYSQL_HOST) {
    console.log(`[Frontend Pod Server] MySQL configured: ${process.env.MYSQL_USER}@${process.env.MYSQL_HOST}:${process.env.MYSQL_PORT || 3306}/${process.env.MYSQL_DATABASE}`);
  }
});

function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Shutting down frontend server...`);
  server.close(async () => {
    if (pool) {
      try {
        await pool.end();
        console.log("Closed MySQL pool cleanly.");
      } catch (err) {
        console.error("Error closing MySQL pool:", err);
      }
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forceful shutdown timeout expired.");
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
