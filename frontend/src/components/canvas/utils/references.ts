/**
 * Exchange the images occupying two reference slots without adding or removing
 * a reference. Slot mentions such as @图片1 stay attached to the slot number.
 */
export function swapReferenceSlots(refIds: string[], draggedId: string, targetId: string): string[] {
  if (draggedId === targetId) return refIds;
  const fromIndex = refIds.indexOf(draggedId);
  const toIndex = refIds.indexOf(targetId);
  if (fromIndex < 0 || toIndex < 0) return refIds;
  const next = [...refIds];
  [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
  return next;
}
