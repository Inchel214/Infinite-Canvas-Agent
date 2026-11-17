import type { PendingContainer } from "../types";

// Copy only editable inputs. Preview/error/progress belong to the original job.
export function duplicateGenerationRecipe(
  source: PendingContainer, id: string, x: number, y: number,
): PendingContainer {
  return {
    id, x, y, w: source.w, h: source.h,
    aspect: source.aspect, resolution: source.resolution, count: 1,
    prompt: source.prompt, refIds: [...source.refIds],
    experienceIds: source.experienceIds ? [...source.experienceIds] : undefined,
  };
}
