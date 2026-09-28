import { useCallback, useState } from "react";

const COPY_FEEDBACK_MS = 2000;

export function useClipboard(feedbackMs = COPY_FEEDBACK_MS) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), feedbackMs);
      } catch {
        // ignore clipboard errors
      }
    },
    [feedbackMs],
  );

  return { copied, copy };
}
