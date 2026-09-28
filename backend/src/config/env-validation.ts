// P0-11: validated environment contract. Called once at boot (see index.ts).
// Production fail-fast on missing secrets; development warns only so the
// clearly-labeled local LLM fallback keeps working key-less. Never throws
// on import — only when validateEnv() is invoked.

function hasKey(name: string): boolean {
  const v = process.env[name]?.trim() || "";
  return v !== "" && !v.startsWith("sk-placeholder") && v !== "test-api-key";
}

export interface EnvReport {
  production: boolean;
  warnings: string[];
}

export function validateEnv(): EnvReport {
  const production = process.env.NODE_ENV === "production";
  const warnings: string[] = [];

  if (!hasKey("OPENAI_API_KEY")) {
    warnings.push("OPENAI_API_KEY is missing");
  }
  if (process.env.LANGFUSE_ENABLED === "true") {
    if (!hasKey("LANGFUSE_PUBLIC_KEY") || !hasKey("LANGFUSE_SECRET_KEY")) {
      warnings.push("LANGFUSE_ENABLED=true but LANGFUSE_PUBLIC_KEY/SECRET_KEY missing: tracing disabled.");
    }
  }
  if ((process.env.CORS_ORIGIN || "*") === "*") {
    warnings.push("CORS_ORIGIN is wildcard: set an explicit allowlist.");
  }

  for (const w of warnings) {
    console.warn(`[env] ${w}`);
  }
  if (production && warnings.length > 0) {
    throw new Error(`Invalid environment: ${warnings.join(" ")}`);
  }
  return { production, warnings };
}
