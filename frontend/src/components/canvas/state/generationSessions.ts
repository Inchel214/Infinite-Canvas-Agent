import type { PendingContainer } from "../types";

type ProcessingBox = { id: number; x: number; y: number; w: number; h: number; label: string };
type GenerationState = {
  containers: PendingContainer[];
  generatingIds: Set<string>;
  genProgressMap: Record<string, number>;
  processingBoxes: ProcessingBox[];
};
type Update<T> = T | ((previous: T) => T);

// Requests outlive the Canvas component when its key changes. Keep their state
// and setters attached to the originating canvas, including while it is hidden.
function createGenerationSession() {
  let snapshot: GenerationState = {
    containers: [], generatingIds: new Set(), genProgressMap: {}, processingBoxes: [],
  };
  const listeners = new Set<() => void>();
  const generatingIdsRef = { current: snapshot.generatingIds };
  const generatingPositionsRef = { current: {} as Record<string, { x: number; y: number }> };
  const processingSeqRef = { current: 0 };

  function setter<K extends keyof GenerationState>(key: K) {
    return (update: Update<GenerationState[K]>) => {
      const value = typeof update === "function" ? update(snapshot[key]) : update;
      if (Object.is(value, snapshot[key])) return;
      snapshot = { ...snapshot, [key]: value };
      generatingIdsRef.current = snapshot.generatingIds;
      listeners.forEach((listener) => listener());
    };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setContainers: setter("containers"),
    setGeneratingIds: setter("generatingIds"),
    setGenProgressMap: setter("genProgressMap"),
    setProcessingBoxes: setter("processingBoxes"),
    generatingIdsRef, generatingPositionsRef, processingSeqRef,
  };
}

const sessions = new Map<string | null, ReturnType<typeof createGenerationSession>>();

export function getGenerationSession(canvasId: string | null) {
  let session = sessions.get(canvasId);
  if (!session) {
    session = createGenerationSession();
    sessions.set(canvasId, session);
  }
  return session;
}
