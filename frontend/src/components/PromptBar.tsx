import { useState } from "react";

interface PromptBarProps {
  onSend: (prompt: string) => void;
  loading: boolean;
}

export function PromptBar({ onSend, loading }: PromptBarProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || loading) return;
    onSend(value.trim());
    setValue("");
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 8,
        width: "min(600px, 90vw)",
        zIndex: 1000,
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="输入指令，例如：生成一张赛博朋克城市 / 结合两张图"
        style={{
          flex: 1,
          padding: "12px 16px",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.2)",
          background: "rgba(30,30,50,0.9)",
          color: "#fff",
          fontSize: 14,
          outline: "none",
        }}
      />
      <button
        type="submit"
        disabled={loading}
        style={{
          padding: "12px 24px",
          borderRadius: 8,
          border: "none",
          background: loading ? "#555" : "#6366f1",
          color: "white",
          cursor: loading ? "not-allowed" : "pointer",
          fontSize: 14,
          fontWeight: 500,
        }}
      >
        {loading ? "生成中..." : "发送"}
      </button>
    </form>
  );
}
