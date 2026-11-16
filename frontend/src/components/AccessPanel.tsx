import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { getLanIps } from "../api/agent";

/**
 * 手机/平板扫码访问面板。
 *
 * 本机 IP 会随 DHCP 变化、也不该让普通用户去 ipconfig 里找，
 * 所以由后端枚举本机局域网地址，这里直接给出地址 + 二维码，平板扫一下就能打开。
 */
export function AccessPanel({ onClose }: { onClose: () => void }) {
  const [ips, setIps] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    let cancelled = false;
    getLanIps()
      .then((list) => {
        if (!cancelled) setIps(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setIps([]);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 端口跟随当前页面：PC 用 5173 打开时，平板也要访问 5173
  const port = window.location.port;
  const urls = (ips ?? []).map((ip) => `http://${ip}${port ? `:${port}` : ""}`);
  const current = urls[active] ?? "";

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
          width: 380,
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
        <div style={{ marginTop: 6, fontSize: 12, color: "#a9a4c9", lineHeight: 1.6 }}>
          手机 / 平板连同一个 WiFi，用相机扫码即可打开；电脑和浏览器保持运行。
        </div>

        {ips === null && (
          <div style={{ marginTop: 20, fontSize: 13, color: "#a9a4c9" }}>正在获取局域网地址…</div>
        )}

        {ips !== null && urls.length === 0 && (
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
              <QRCodeSVG value={current} size={180} level="M" marginSize={2} />
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
                {current}
              </code>
              <button
                type="button"
                onClick={() => void copy(current)}
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
                {copied === current ? "已复制" : "复制"}
              </button>
            </div>
          </>
        )}

        {urls.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "#a9a4c9", marginBottom: 6 }}>
              检测到多个网卡，扫码打不开就换一个：
            </div>
            {urls.map((url, i) => (
              <button
                key={url}
                type="button"
                onClick={() => setActive(i)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  marginBottom: 6,
                  padding: "6px 10px",
                  borderRadius: 7,
                  border: `1px solid ${i === active ? "rgba(99,102,241,0.7)" : "rgba(255,255,255,0.1)"}`,
                  background: i === active ? "rgba(99,102,241,0.18)" : "rgba(255,255,255,0.04)",
                  color: i === active ? "#c7d2fe" : "#bbb",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {url}
              </button>
            ))}
          </div>
        )}

        <div style={{ marginTop: 14, fontSize: 12, color: "#8a86a8", lineHeight: 1.6 }}>
          打不开时：确认在同一 WiFi，并在 Windows 防火墙提示中允许 5173 / 8000 端口。
        </div>
      </div>
    </div>
  );
}
