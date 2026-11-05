// 几何计算函数

import type { CanvasNode, BBox } from "../types";

// 所有连线段（源图中心 → 目标图中心）
export function segmentsOf(nodes: CanvasNode[]): Array<[number, number, number, number]> {
  const segs: Array<[number, number, number, number]> = [];
  for (const n of nodes) {
    if (!n.source_ids) continue;
    for (const sid of n.source_ids) {
      const s = nodes.find((m) => m.id === sid);
      if (s) {
        segs.push([
          s.x + s.width / 2,
          s.y + s.height / 2,
          n.x + n.width / 2,
          n.y + n.height / 2,
        ]);
      }
    }
  }
  return segs;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// 线段是否穿过矩形（端点在内 或 与任一边相交）
export function segHitsRect(
  x1: number, y1: number, x2: number, y2: number,
  rx: number, ry: number, rw: number, rh: number
): boolean {
  if (rx <= x1 && x1 <= rx + rw && ry <= y1 && y1 <= ry + rh) return true;
  if (rx <= x2 && x2 <= rx + rw && ry <= y2 && y2 <= ry + rh) return true;
  const segCross = (
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number
  ) => {
    const o1 = orient(ax, ay, bx, by, cx, cy);
    const o2 = orient(ax, ay, bx, by, dx, dy);
    const o3 = orient(cx, cy, dx, dy, ax, ay);
    const o4 = orient(cx, cy, dx, dy, bx, by);
    if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0) return true; // 共线保守处理
    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
  };
  const edges: Array<[number, number, number, number]> = [
    [rx, ry, rx + rw, ry],
    [rx, ry + rh, rx + rw, ry + rh],
    [rx, ry, rx, ry + rh],
    [rx + rw, ry, rx + rw, ry + rh],
  ];
  return edges.some((e) => segCross(x1, y1, x2, y2, e[0], e[1], e[2], e[3]));
}

// (x, y) 处放 w×h 是否避开了所有节点（带 padding）和连线
export function spotFree(
  nodes: CanvasNode[],
  segs: Array<[number, number, number, number]>,
  x: number,
  y: number,
  w: number,
  h: number,
  pad = 24
): boolean {
  const px = x - pad, py = y - pad, pw = w + 2 * pad, ph = h + 2 * pad;
  for (const n of nodes) {
    if (px < n.x + n.width && px + pw > n.x && py < n.y + n.height && py + ph > n.y) {
      return false;
    }
  }
  for (const [x1, y1, x2, y2] of segs) {
    if (segHitsRect(x1, y1, x2, y2, px, py, pw, ph)) return false;
  }
  return true;
}

/**
 * 根据源节点和目标节点的相对位置，自动选择最佳连接端口，
 * 并返回贝塞尔曲线的起点、终点和两个控制点。
 *
 * 规则：比较两节点中心连线的 dx/dy，取绝对值较大的轴为主轴：
 *   - 水平主轴：源右→目标左（目标在右）或 源左→目标右（目标在左）
 *   - 垂直主轴：源下→目标上（目标在下）或 源上→目标下（目标在上）
 * 控制点沿主轴方向延伸，保证曲线自然不回折。
 */
export function getConnectionEndpoints(src: BBox, tgt: BBox) {
  const srcCx = src.x + src.width / 2;
  const srcCy = src.y + src.height / 2;
  const tgtCx = tgt.x + tgt.width / 2;
  const tgtCy = tgt.y + tgt.height / 2;

  const dx = tgtCx - srcCx;
  const dy = tgtCy - srcCy;

  const horizontal = Math.abs(dx) >= Math.abs(dy);

  let x1: number, y1: number, x2: number, y2: number;
  let cx1: number, cy1: number, cx2: number, cy2: number;

  if (horizontal) {
    if (dx >= 0) {
      // 目标在右侧：源右边 → 目标左边
      x1 = src.x + src.width;
      y1 = srcCy;
      x2 = tgt.x;
      y2 = tgtCy;
    } else {
      // 目标在左侧：源左边 → 目标右边
      x1 = src.x;
      y1 = srcCy;
      x2 = tgt.x + tgt.width;
      y2 = tgtCy;
    }
    // offset 不超过端点水平距离的一半：图靠得近时曲线保持单弧，不产生 S 形
    const offset = Math.min(Math.max(40, Math.abs(dx) / 2), Math.max(12, Math.abs(x2 - x1) / 2));
    const dir = dx >= 0 ? 1 : -1;
    cx1 = x1 + dir * offset;
    cy1 = y1;
    cx2 = x2 - dir * offset;
    cy2 = y2;
  } else {
    if (dy >= 0) {
      // 目标在下：源下边 → 目标上边
      x1 = srcCx;
      y1 = src.y + src.height;
      x2 = tgtCx;
      y2 = tgt.y;
    } else {
      // 目标在上：源上边 → 目标下边
      x1 = srcCx;
      y1 = src.y;
      x2 = tgtCx;
      y2 = tgt.y + tgt.height;
    }
    const offset = Math.min(Math.max(40, Math.abs(dy) / 2), Math.max(12, Math.abs(y2 - y1) / 2));
    const dir = dy >= 0 ? 1 : -1;
    cx1 = x1;
    cy1 = y1 + dir * offset;
    cx2 = x2;
    cy2 = y2 - dir * offset;
  }

  return { x1, y1, x2, y2, cx1, cy1, cx2, cy2 };
}
