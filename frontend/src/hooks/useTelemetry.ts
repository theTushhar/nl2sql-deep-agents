import { useCallback, useState } from "react";
import type { Telemetry } from "../types";

/**
 * Single-shot telemetry store. The backend returns one envelope per
 * POST /api/query, so each response replaces the previous telemetry —
 * there is no streaming/append path.
 */
export function useTelemetry() {
  const [telemetry, setTelemetryState] = useState<Telemetry | null>(null);

  const setTelemetry = useCallback((newTelemetry: Telemetry | undefined) => {
    if (!newTelemetry) return;
    // Deep-clone so later mutations of the envelope can't corrupt state.
    setTelemetryState(JSON.parse(JSON.stringify(newTelemetry)));
  }, []);

  const resetTelemetry = useCallback(() => {
    setTelemetryState(null);
  }, []);

  return { telemetry, setTelemetry, resetTelemetry };
}
