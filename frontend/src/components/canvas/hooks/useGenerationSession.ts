import { useMemo, useSyncExternalStore } from "react";
import { getGenerationSession } from "../state/generationSessions";

export function useGenerationSession(canvasId: string | null) {
  const session = useMemo(() => getGenerationSession(canvasId), [canvasId]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return { ...session, ...state };
}
