import { useEffect, useMemo, useState } from "react";
import type { CanvasNode } from "../types/canvas";

export type Collection = { id: string; name: string; memberIds: string[]; coverId: string; collapsed: boolean; x?: number; y?: number };
export type ImageCollectionView = Collection & { members: CanvasNode[]; cover: CanvasNode; x: number; y: number; width: number; height: number };

// Collections are presentation metadata: original nodes, coordinates and references remain intact.
export function useImageCollections(canvasId: string | null, nodes: CanvasNode[]) {
  const key = `ica:image-collections:${canvasId}`;
  const [collections, setCollections] = useState<Collection[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (!Array.isArray(saved)) return [];
      const used = new Set<string>();
      return saved.flatMap((item): Collection[] => {
        if (!item || typeof item.id !== "string" || typeof item.name !== "string" || !Array.isArray(item.memberIds)) return [];
        const memberIds = item.memberIds.filter((id: unknown): id is string => typeof id === "string" && !used.has(id));
        memberIds.forEach((id: string) => used.add(id));
        return memberIds.length ? [{ id: item.id, name: item.name.slice(0, 80), memberIds,
          ...(Number.isFinite(item.x) && Number.isFinite(item.y) ? { x: item.x, y: item.y } : {}),
          coverId: memberIds.includes(item.coverId) ? item.coverId : memberIds[0], collapsed: item.collapsed !== false }] : [];
      });
    } catch { return []; }
  });
  const [saveError, setSaveError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let failed = false;
    try { localStorage.setItem(key, JSON.stringify(collections)); }
    catch { failed = true; }
    // The storage result is external state; report it after this effect has committed.
    queueMicrotask(() => { if (!cancelled) setSaveError(failed); });
    return () => { cancelled = true; };
  }, [key, collections]);

  const views = useMemo(() => collections.flatMap((collection): ImageCollectionView[] => {
    const members = collection.memberIds.map((id) => nodes.find((node) => node.id === id))
      .filter((node): node is CanvasNode => !!node && node.type === "image" && !!node.image_url);
    if (!members.length) return [];
    const cover = members.find((node) => node.id === collection.coverId) ?? members[0];
    // Canvas nodes already include the user's local display-size overrides.
    const averageWidth = members.reduce((sum, node) => sum + (Number.isFinite(node.width) && node.width > 0 ? node.width : 216), 0) / members.length;
    const averageHeight = members.reduce((sum, node) => sum + (Number.isFinite(node.height) && node.height > 0 ? node.height : 220), 0) / members.length;
    return [{ ...collection, members, cover,
      x: collection.collapsed && collection.x != null ? collection.x : Math.min(...members.map((node) => node.x)),
      y: collection.collapsed && collection.y != null ? collection.y : Math.min(...members.map((node) => node.y)),
      width: averageWidth + 64, height: collection.collapsed ? averageHeight + 66 : 48 }];
  }), [collections, nodes]);
  const collapsedByNode = new Map<string, ImageCollectionView>();
  views.filter((group) => group.collapsed).forEach((group) => group.members.forEach((node) => collapsedByNode.set(node.id, group)));
  const visibleNodes = nodes.filter((node) => !collapsedByNode.has(node.id));
  const update = (id: string, patch: Partial<Collection>) => setCollections((previous) => previous.map((group) => group.id === id ? { ...group, ...patch } : group));
  const create = (ids: string[]) => {
    const members = ids.filter((id) => nodes.some((node) => node.id === id && node.type === "image" && node.image_url));
    if (members.length < 2) return null;
    const group: Collection = { id: crypto.randomUUID(), name: `图片组 ${collections.length + 1}`, memberIds: members, coverId: members[0], collapsed: true };
    const selected = new Set(members);
    setCollections((previous) => [...previous.map((group) => ({ ...group, memberIds: group.memberIds.filter((id) => !selected.has(id)) }))
      .filter((group) => group.memberIds.length),
      group]);
    const memberNodes = nodes.filter((node) => selected.has(node.id));
    return { ...group, x: Math.min(...memberNodes.map((node) => node.x)), y: Math.min(...memberNodes.map((node) => node.y)) };
  };
  const remove = (id: string, memberId: string) => setCollections((previous) => previous.map((group) => {
    if (group.id !== id) return group;
    const memberIds = group.memberIds.filter((nodeId) => nodeId !== memberId);
    return { ...group, memberIds, coverId: group.coverId === memberId ? memberIds[0] ?? "" : group.coverId };
  }).filter((group) => group.memberIds.length));
  const dissolve = (id: string) => setCollections((previous) => previous.filter((group) => group.id !== id));
  return { views, visibleNodes, collapsedByNode, update, create, remove, dissolve, saveError };
}
