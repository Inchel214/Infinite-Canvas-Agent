import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { getLanInterfaces, type LanInterface } from "../api/agent";

const REFRESH_INTERVAL = 10000;

/**
 * 手机/平板扫码访问面板。
 *
 * 本机 IP 会随 DHCP 变化、也不该让普通用户去 ipconfig 里找，
 * 所以由后端枚举本机局域网地址，这里直接给出地址 + 二维码，平板扫一下就能打开。
 * 多网卡（有线+WiFi、VMware/Docker/VPN）时给错地址是扫码失败的主因，
 * 因此列出每张网卡及其状态，并在面板打开期间定时刷新，避免展示过期地址。
 */
export function AccessPanel({ onClose }: { onClose: () => void }) {
  const [interfaces, setInterfaces] = useState<LanInterface[] | null>(null);
  const [error, setError] = useState("");
  const [activeIp, setActiveIp] = useState("");
  const [copied, setCopied] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  // 刷新期间不清空旧列表，避免二维码闪烁
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setRefreshing(true);
    try {
      const list = await getLanInterfaces();
      setInterfaces(list);
      setError("");
      setLastUpdated(Date.now());
      // 保留用户手动选中的网卡；该地址消失时回落到后端推荐的第一个
      setActiveIp((prev) => (list.some((item) => item.ip === prev) ? prev : (list[0]?.ip ?? "")));
    } catch (err) {
      setInterfaces((prev) => prev ?? []);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL);
    return () => window.clearInterval(timer);
  }, [load]);

  // 端口跟随当前页面：PC 用 5173 打开时，平板也要访问 5173
  const port = window.location.port;
  const entries = (interfaces ?? []).map((item) => ({
    ...item,
    url: `http://${item.ip}${port ? `:${port}` : ""}`,
  }));
  const current = entries.find((item) => item.ip === activeIp) ?? entries[0];

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      // 剪贴板不可用时用户可长按地址手动复制
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 400,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          background: "#22223a",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 14,
          padding: 20,
          color: "#eee",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>在手机 / 平板上打开</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              onClick={() => void load()}
              title="重新检测局域网地址"
              style={{
                padding: "4px 10px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "transparent",
                color: "#bbb",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {refreshing ? "检测中…" : "刷新地址"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "transparent",
                color: "#bbb",
                cursor: "pointer",
                fontSize: 15,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: "#a9a4c9", lineHeight: 1.6 }}>
          手机 / 平板连同一个 WiFi，用相机扫码即可打开；电脑和浏览器保持运行。
        </div>

        {interfaces === null && (
          <div style={{ marginTop: 20, fontSize: 13, color: "#a9a4c9" }}>正在获取局域网地址…</div>
        )}

        {interfaces !== null && entries.length === 0 && (
          <div style={{ marginTop: 20, fontSize: 13, color: "#f87171", lineHeight: 1.7 }}>
            没检测到局域网地址：请确认电脑已连上 WiFi 或网线
            {error ? `（${error}）` : ""}
          </div>
        )}

        {current && (
          <>
            <div
              style={{
                marginTop: 16,
                padding: 14,
                background: "#fff",
                borderRadius: 10,
                display: "flex",
                justifyContent: "center",
              }}
            >
              <QRCodeSVG value={current.url} size={180} level="M" marginSize={2} />
            </div>
            <div
              style={{
                marginTop: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8,
                padding: "8px 10px",
              }}
            >
              <code style={{ flex: 1, fontSize: 13, wordBreak: "break-all", color: "#e0e7ff" }}>
                {current.url}
              </code>
              <button
                type="button"
                onClick={() => void copy(current.url)}
                style={{
                  flex: "none",
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.16)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#ddd",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {copied === current.url ? "已复制" : "复制"}
              </button>
            </div>
            {!current.listening && (
              <div style={{ marginTop: 10, fontSize: 12, color: "#fbbf24", lineHeight: 1.6 }}>
                后端没有监听在这个地址上：页面也许能打开，但会一直白屏。
                后端需用 <code>--host 0.0.0.0 --port 8000</code> 启动。
              </div>
            )}
          </>
        )}

        {entries.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "#a9a4c9", marginBottom: 6 }}>
              {entries.length > 1 ? "检测到多个网卡，扫码打不开就换一个：" : "本机局域网地址："}
            </div>
            {entries.map((item) => {
              const selected = item.ip === current?.ip;
              return (
                <button
                  key={item.ip}
                  type="button"
                  onClick={() => setActiveIp(item.ip)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    marginBottom: 6,
                    padding: "6px 10px",
                    borderRadius: 7,
                    border: `1px solid ${selected ? "rgba(99,102,241,0.7)" : "rgba(255,255,255,0.1)"}`,
                    background: selected ? "rgba(99,102,241,0.18)" : "rgba(255,255,255,0.04)",
                    color: selected ? "#c7d2fe" : item.virtual ? "#77738f" : "#bbb",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "monospace" }}>{item.ip}</span>
                    {item.isDefault && <Badge text="推荐" color="#34d399" />}
                    {item.virtual && <Badge text="虚拟网卡" color="#f87171" />}
                    {!item.listening && <Badge text="8000 未监听" color="#fbbf24" />}
                  </div>
                  {item.interface && (
                    <div style={{ marginTop: 3, fontSize: 11, color: "#8a86a8" }}>{item.interface}</div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: 14, fontSize: 12, color: "#8a86a8", lineHeight: 1.7 }}>
          打不开时按顺序排查：
          <br />
          1. 平板与电脑在同一个 WiFi（地址前三段一致），路由器未开 AP 隔离。
          <br />
          2. Windows 防火墙放行 5173 / 8000 端口（首次弹窗若点了取消，需手动删除拒绝规则）。
          <br />
          3. iPad / Mac 的「设置 → 隐私与安全性 → 本地网络」里允许浏览器访问，并关闭全局代理 / VPN。
          {lastUpdated && (
            <div style={{ marginTop: 6, color: "#6d6890" }}>
              每 {REFRESH_INTERVAL / 1000} 秒自动刷新 · 上次{" "}
              {new Date(lastUpdated).toLocaleTimeString()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 4,
        border: `1px solid ${color}`,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}
