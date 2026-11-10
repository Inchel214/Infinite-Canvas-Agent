// 风格库相关工具函数

import { EXPERIENCE_USAGE_KEY, EXPERIENCE_USAGE_EVENT, IMAGE_MENTION_RE } from "../constants";

export function readExperienceUsage(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXPERIENCE_USAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// 只在真正发起生成时累计，风格下拉据此把常用项逐步排到前面。
export function recordExperienceUsage(ids?: string[]) {
  if (!ids?.length) return;
  try {
    const usage = readExperienceUsage();
    ids.forEach((id) => {
      usage[id] = (Number(usage[id]) || 0) + 1;
    });
    localStorage.setItem(EXPERIENCE_USAGE_KEY, JSON.stringify(usage));
    window.dispatchEvent(new Event(EXPERIENCE_USAGE_EVENT));
  } catch {
    // 本地统计不可用时不应阻断图片生成。
  }
}

// 删除参考图时让图片提及继续指向原图；槽位替换会显式跳过这一步。
export function remapImageMentions(prompt: string, oldRefIds: string[], newRefIds: string[]): string {
  return prompt
    .replace(IMAGE_MENTION_RE, (mention, rawIndex: string) => {
      const refId = oldRefIds[Number(rawIndex) - 1];
      if (!refId) return mention;
      const nextIndex = newRefIds.indexOf(refId);
      return nextIndex >= 0 ? `@图片${nextIndex + 1}` : "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n");
}

export function replaceReferenceSlot(refIds: string[], draggedId: string, targetId: string): string[] {
  if (draggedId === targetId || !refIds.includes(draggedId) || !refIds.includes(targetId)) return refIds;
  const next = refIds.filter((refId) => refId !== draggedId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0) return refIds;
  next[targetIndex] = draggedId;
  return next;
}
