import { useEffect } from "react";

export type TelemetryEvent = {
  ts?: number;
  type: string;
  level?: "debug" | "info" | "warning" | "error";
  text?: string;
  message?: string;
  method?: string;
  url?: string;
  failure?: string;
};

export function useTelemetryStream(
  _runId: string | null,
  _onEvent: (event: TelemetryEvent) => void
): void {
  useEffect(() => {
    // Telemetry stream is optional; no-op when backend stream is unavailable.
    return;
  }, []);
}
