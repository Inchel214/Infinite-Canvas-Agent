// 宽高比相关计算函数

import { ASPECT_RATIOS, RESOLUTIONS } from "../constants";

// 从 ratioKey 解析宽高比（预设或 "W:H" 自定义格式）
export function parseRatio(ratioKey: string): { w: number; h: number } {
  const preset = ASPECT_RATIOS.find((r) => r.key === ratioKey);
  if (preset) return { w: preset.w, h: preset.h };
  const m = ratioKey.match(/^(\d+):(\d+)$/);
  if (m) return { w: parseInt(m[1]), h: parseInt(m[2]) };
  return { w: 1, h: 1 }; // 回退 1:1
}

// 按节点当前宽高比找最接近的预设或返回自定义比例（编辑图片时默认继承原图比例）
export function closestAspectKey(w: number, h: number): string {
  const target = w / h;
  let best: (typeof ASPECT_RATIOS)[number] = ASPECT_RATIOS[0];
  let bestDiff = Infinity;
  for (const r of ASPECT_RATIOS) {
    const diff = Math.abs(r.w / r.h - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  // 与最接近的预设差距 > 0.05 时，返回简化的 "W:H" 自定义比例
  if (bestDiff > 0.05) {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const g = gcd(w, h) || 1;
    return `${w / g}:${h / g}`;
  }
  return best.key;
}

// 参考图接入容器时只选现有画布预设，不生成难以理解的自定义比例。
export function closestPresetAspectKey(w: number, h: number): string {
  const target = w / h;
  return ASPECT_RATIOS.reduce((best, ratio) =>
    Math.abs(ratio.w / ratio.h - target) < Math.abs(best.w / best.h - target)
      ? ratio
      : best,
  ).key;
}

// 按图片像素长边找最接近的分辨率档位（编辑图片时默认继承原图分辨率）
export function closestResolutionKey(longEdge: number): string {
  const tiers: [string, number][] = [
    ["1K", 1024],
    ["2K", 2048],
    ["4K", 4096],
  ];
  let best = "2K";
  let bestDiff = Infinity;
  for (const [key, px] of tiers) {
    const diff = Math.abs(px - longEdge);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = key;
    }
  }
  return best;
}

// 按比例 + 分辨率档位计算 size 字符串（如 "2048x1152"）
// 比例为空表示“自动”：返回空串，调用方不传 size，交由模型决定输出比例
export function calcSize(ratioKey: string, res: string): string {
  if (!ratioKey) return "";
  const ratio = parseRatio(ratioKey);
  const long = res === "1K" ? 1024 : res === "4K" ? 4096 : 2048;
  let w = ratio.w >= ratio.h ? long : Math.round((long * ratio.w) / ratio.h);
  let h = ratio.w >= ratio.h ? Math.round((long * ratio.h) / ratio.w) : long;
  // Seedream 要求 512~4096 且为 32 的倍数
  w = Math.max(512, Math.min(4096, Math.round(w / 32) * 32));
  h = Math.max(512, Math.min(4096, Math.round(h / 32) * 32));
  // 模型总像素下限 921600（≈960x960，实测 4.0/5.0 Pro）：不足时等比放大（32 倍数对齐），
  // 保证 UI 计算的尺寸与后端实际发送、图片真实输出一致（如 1K 16:9 → 1280x736）
  const MIN_AREA = 921600;
  if (w * h < MIN_AREA) {
    const s = Math.sqrt(MIN_AREA / (w * h));
    w = Math.max(32, Math.ceil((w * s) / 32) * 32);
    h = Math.max(32, Math.ceil((h * s) / 32) * 32);
  }
  return `${w}x${h}`;
}
