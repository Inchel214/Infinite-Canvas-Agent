import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { CanvasNode } from "../types/canvas";
import type { ImageCollectionView } from "./useImageCollections";

const buttonStyle: CSSProperties = { border: "1px solid rgba(196,181,253,.25)", borderRadius: 6,
  background: "rgba(167,139,250,.1)", color: "#e5e7eb", padding: "6px 10px", cursor: "pointer", fontSize: 12 };

export function ImageCollectionCards({ groups, zoom, update, onManage }: {
  zoom: number;
  groups: ImageCollectionView[];
  update: (id: string, patch: { collapsed?: boolean; x?: number; y?: number }) => void;
  onManage: (id: string) => void;
}) {
  return <>{groups.map((group) => <ImageCollectionCard key={`${group.id}:${group.coverId}`} group={group} zoom={zoom} update={update} onManage={onManage} />)}</>;
}

function ImageCollectionCard({ group, zoom, update, onManage }: {
  zoom: number;
  group: ImageCollectionView;
  update: (id: string, patch: { collapsed?: boolean; x?: number; y?: number }) => void;
  onManage: (id: string) => void;
}) {
  const [activeId, setActiveId] = useState(group.cover.id);
  const moving = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const activeIndex = Math.max(0, group.members.findIndex((node) => node.id === activeId));
  const active = group.members[activeIndex];
  const stageRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const labelScale = Math.max(1, 1 / Math.max(zoom, 0.05));
  const step = useCallback((direction: number) => setActiveId((previous) => {
    const index = Math.max(0, group.members.findIndex((node) => node.id === previous));
    return group.members[(index + direction + group.members.length) % group.members.length].id;
  }), [group.members]);
  // Own horizontal scrolling locally so it never pans/zooms the canvas.
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    let delta = 0, lastEvent = 0, lastStep = 0;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || (!event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY))) return;
      event.preventDefault();
      event.stopPropagation();
      const now = performance.now();
      if (now - lastEvent > 180) delta = 0;
      lastEvent = now;
      delta += event.deltaX || event.deltaY;
      if (Math.abs(delta) < 40 || now - lastStep < 260) return;
      const direction = Math.sign(delta);
      step(direction);
      delta = 0;
      lastStep = now;
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [step, group.collapsed]);
  const arrowStyle: CSSProperties = { ...buttonStyle, position: "absolute", top: "45%", zIndex: 5,
    display: "grid", placeItems: "center", lineHeight: 1, boxSizing: "border-box", width: 30, height: 30, padding: 0, borderRadius: "50%", background: "rgba(22,22,37,.86)", fontSize: 23,
    boxShadow: "0 2px 8px #0005" };
  return <section data-collection-id={group.id} aria-label={`${group.name}，${group.members.length} 张图片`}
    onMouseDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onManage(group.id); }}
    style={{ position: "absolute", left: group.collapsed ? position?.x ?? group.x : group.x, top: group.collapsed ? position?.y ?? group.y : group.y - 58,
      width: group.width, boxSizing: "border-box", borderRadius: 12,
      background: group.collapsed ? "transparent" : "#25253d", padding: 10,
      animation: "ica-img-in .18s ease-out both", zIndex: 2 }}>
    {group.collapsed && <div ref={stageRef} role="region" aria-label="图片组轮播" tabIndex={0}
      title="点击、左右拖动、横向滚动或点击箭头切换"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); event.stopPropagation(); step(event.key === "ArrowRight" ? 1 : -1);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        event.stopPropagation();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        const start = gesture.current;
        if (!start || start.pointerId !== event.pointerId) return;
        setDrag({ x: 110 * Math.tanh((event.clientX - start.x) / (110 * zoom)),
          y: 60 * Math.tanh((event.clientY - start.y) / (60 * zoom)) });
      }}
      onPointerUp={(event) => {
        const start = gesture.current;
        gesture.current = null;
        setDrag({ x: 0, y: 0 });
        if (!start || start.pointerId !== event.pointerId) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dx) >= 30 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
        else if (Math.hypot(dx, dy) < 6) step(1);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { gesture.current = null; setDrag({ x: 0, y: 0 }); }}
      onLostPointerCapture={() => { gesture.current = null; setDrag({ x: 0, y: 0 }); }}
      style={{ position: "relative", height: group.height - 66, touchAction: "none", cursor: "grab", userSelect: "none", outlineOffset: 5 }}>
      <style>{`
        .collection-swap-card { transition: transform 600ms cubic-bezier(.22,1,.36,1), opacity 350ms ease; }
        @media (prefers-reduced-motion: reduce) { .collection-swap-card { transition: none; } }
      `}</style>
      <div style={{ position: "absolute", inset: "0 22px", perspective: 850, perspectiveOrigin: "center", pointerEvents: "none", zIndex: 0 }}>
        {group.members.map((member, index) => {
          const depth = (index - activeIndex + group.members.length) % group.members.length;
          const isPrevious = depth === group.members.length - 1 && depth !== 0;
          const side = depth === 0 ? 0 : isPrevious ? -1 : 1;
          const isVisible = depth === 0 || depth === 1 || isPrevious;
          const following = depth === 0 && (drag.x !== 0 || drag.y !== 0);
          return <div key={member.id} className="collection-swap-card" aria-hidden={depth !== 0}
            data-front={depth === 0 || undefined}
            style={{ position: "absolute", inset: 0, borderRadius: 13, overflow: "hidden", background: "#121219",
              border: "1px solid #666073", backfaceVisibility: "hidden",
              transform: depth === 0
                ? `translate3d(${drag.x}px, ${drag.y}px, 0) rotate(${drag.x * .045}deg)`
                : `translate3d(${side * 23}px, 8px, -35px) scale(.94) rotate(${side * 3}deg)`,
              zIndex: depth === 0 ? 3 : 1, opacity: isVisible ? 1 : 0,
              transition: following ? "none" : undefined, boxShadow: "0 5px 14px #0005" }}>
            <img src={member.image_url} alt={depth === 0 ? `${group.name} 第 ${activeIndex + 1} 张图片` : ""}
              draggable={false} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          </div>;
        })}
      </div>
      {group.members.length > 1 && <>
        <button type="button" aria-label="上一张图片" style={{ ...arrowStyle, left: -4 }} onClick={() => step(-1)}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg></button>
        <button type="button" aria-label="下一张图片" style={{ ...arrowStyle, right: -4 }} onClick={() => step(1)}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg></button>
      </>}
      <span role="status" aria-live="polite" style={{ position: "absolute", bottom: 8, left: "50%", transform: `translateX(-50%) scale(${labelScale})`, transformOrigin: "center bottom", zIndex: 4,
        borderRadius: 12, padding: "3px 8px", background: "#111b", color: "white", fontSize: 12, pointerEvents: "none", whiteSpace: "nowrap" }}>
        {activeIndex + 1} / {group.members.length} · #{active.index ?? active.id.slice(0, 8)}
      </span>
    </div>}
    <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: group.collapsed ? 17 : 0, width: Math.max(260, (group.width - 20) / labelScale), transform: `scale(${labelScale})`, transformOrigin: "top left" }}>
      <span title={group.collapsed ? `${group.name} · 拖动名称可移动图片组` : group.name}
        role={group.collapsed ? "button" : undefined} aria-label={group.collapsed ? `移动图片组 ${group.name}` : undefined}
        onPointerDown={(event) => {
          if (!group.collapsed || event.button !== 0) return;
          event.preventDefault(); event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          moving.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: group.x, y: group.y };
        }}
        onPointerMove={(event) => {
          const start = moving.current;
          if (!start || start.pointerId !== event.pointerId) return;
          const next = { x: start.x + (event.clientX - start.clientX) / zoom, y: start.y + (event.clientY - start.clientY) / zoom };
          setPosition(next); update(group.id, next);
        }}
        onPointerUp={(event) => {
          if (moving.current?.pointerId !== event.pointerId) return;
          const start = moving.current;
          update(group.id, { x: start.x + (event.clientX - start.clientX) / zoom, y: start.y + (event.clientY - start.clientY) / zoom });
          moving.current = null; setPosition(null);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { moving.current = null; setPosition(null); }}
        onLostPointerCapture={() => { moving.current = null; setPosition(null); }}
        style={{ cursor: group.collapsed ? "grab" : undefined, touchAction: "none", userSelect: "none", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, color: "#f1efff" }}>{group.name}</span>
      <button type="button" style={buttonStyle} onClick={() => update(group.id, { collapsed: !group.collapsed })}>{group.collapsed ? `展开 ${group.members.length}` : "收起"}</button>
      <button type="button" style={buttonStyle} onClick={() => onManage(group.id)}>管理</button>
    </div>
  </section>;
}

export function ImageCollectionDialog({ group, onClose, onRename, onCover, onRemove, onDissolve, onReveal }: {
  group: ImageCollectionView;
  onClose: () => void;
  onRename: (name: string) => void;
  onCover: (id: string) => void;
  onRemove: (id: string) => void;
  onDissolve: () => void;
  onReveal: (node: CanvasNode) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(group.name);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    return () => previous?.focus();
  }, []);
  const commitName = () => { const next = name.trim().slice(0, 80) || group.name; setName(next); onRename(next); };
  return createPortal(<dialog ref={dialogRef} aria-label="管理图片组"
    onCancel={(event) => { event.preventDefault(); commitName(); onClose(); }}
    onKeyDown={(event) => event.stopPropagation()}
    onMouseDown={(event) => event.stopPropagation()}
    style={{ width: "min(860px, calc(100vw - 64px))", maxHeight: "calc(100dvh - 64px)", boxSizing: "border-box", padding: 22,
      background: "#202035", color: "#e5e7eb", border: "1px solid #575174", borderRadius: 16, boxShadow: "0 24px 100px #0008", overflow: "auto" }}>
    <style>{`
      dialog::backdrop { background: rgba(5,5,18,.65); }
      .collection-control { transition: background .15s, transform .12s; }
      .collection-control:hover { background: rgba(167,139,250,.25) !important; }
      .collection-control:active { transform: scale(.97); }
      .collection-member { animation: ica-img-in .18s ease-out both; }
      @media (prefers-reduced-motion: reduce) { .collection-member { animation: none; } }
    `}</style>
    <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 20 }}>
      <input aria-label="图片组名称" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} onBlur={commitName}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { commitName(); event.currentTarget.blur(); } }}
        style={{ flex: 1, minWidth: 0, fontSize: 19, fontWeight: 600, color: "#f4f1ff", background: "transparent", border: "1px solid #56506b", borderRadius: 6, padding: "8px 10px" }} />
      <span style={{ color: "#b3aec8", whiteSpace: "nowrap" }}>{group.members.length} 张</span>
      <button className="collection-control" type="button" style={buttonStyle} onClick={() => { commitName(); onClose(); }}>关闭</button>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16 }}>
      {group.members.map((node) => <article key={node.id} className="collection-member" data-collection-member={node.id}
        style={{ padding: 10, border: `1px solid ${group.cover.id === node.id ? "#a78bfa" : "#444158"}`, borderRadius: 10, minWidth: 0, background: "#29283e" }}>
        <button type="button" title={`在画布中查看 #${node.index ?? node.id}`} onClick={() => { commitName(); onReveal(node); }}
          style={{ width: "100%", height: 190, background: "#191927", padding: 0, border: 0, borderRadius: 6, cursor: "pointer" }}>
          <img src={node.image_url} alt={`图片 #${node.index ?? node.id}`} draggable={false} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </button>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "10px 0", fontSize: 12 }}>
          <span>#{node.index ?? node.id.slice(0, 8)}</span>
          {group.cover.id === node.id && <span style={{ color: "#c4b5fd" }}>当前封面</span>}
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          <button className="collection-control" type="button" disabled={group.cover.id === node.id} style={{ ...buttonStyle, opacity: group.cover.id === node.id ? .45 : 1 }} onClick={() => onCover(node.id)}>设为封面</button>
          <button className="collection-control" type="button" style={buttonStyle} onClick={() => onRemove(node.id)}>移出组</button>
        </div>
      </article>)}
    </div>
    <footer style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginTop: 20, borderTop: "1px solid #444158", paddingTop: 16 }}>
      <span style={{ fontSize: 12, color: "#aaa5bf" }}>移出或解散均保留原图和连线。</span>
      <button className="collection-control" type="button" style={buttonStyle} onClick={onDissolve}>解散组，保留图片</button>
    </footer>
  </dialog>, document.body);
}
