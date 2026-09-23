import { useEffect, useState } from "react";
import {
  getSettings,
  getProviders,
  saveSettings,
  resetSettings,
  testSettings,
  type AppSettingsData,
  type LLMSettings,
  type ImageSettings,
  type ProviderPreset,
  type TestResult,
} from "../api/agent";

interface SettingsPanelProps {
  onClose: () => void;
  onSaved: (settings: AppSettingsData) => void;
}

const UNSET_LABEL = "未设置（跟随 .env / Mock 降级）";
const MOCK_LABEL = "Mock 模式（生成占位图，无需 API Key）";

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 6,
  color: "#eee",
  fontSize: 13,
  padding: "7px 10px",
  outline: "none",
};

// 原生 select 的下拉列表由系统渲染，不吃内联样式：需全局样式把选项改成深色
const SELECT_CSS = `
  .ic-select { appearance: none; -webkit-appearance: none; cursor: pointer; }
  .ic-select option {
    background: #26264a;
    color: #eee;
  }
`;

const labelStyle: React.CSSProperties = {
  display: "block",
  color: "#999",
  fontSize: 12,
  margin: "10px 0 4px",
};

const sectionTitleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  fontWeight: 600,
  color: "#ddd",
  margin: "18px 0 2px",
};

export function SettingsPanel({ onClose, onSaved }: SettingsPanelProps) {
  const [providers, setProviders] = useState<Record<string, ProviderPreset>>({});
  const [llm, setLlm] = useState<LLMSettings>({
    provider: "",
    api_key: "",
    base_url: "",
    model: "",
  });
  const [image, setImage] = useState<ImageSettings>({
    provider: "",
    api_key: "",
    base_url: "",
    model: "",
    stream_model: "",
  });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    llm?: TestResult;
    image?: TestResult;
  }>({});
  const [errorMsg, setErrorMsg] = useState("");
  const [notice, setNotice] = useState("");

  // 加载当前配置 + 服务商预设
  useEffect(() => {
    (async () => {
      try {
        const [settings, providerData] = await Promise.all([
          getSettings(),
          getProviders(),
        ]);
        setLlm(settings.llm);
        setImage(settings.image);
        setProviders(providerData.providers);
      } catch (e) {
        setErrorMsg("加载配置失败：" + (e as Error).message);
      }
    })();
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 切换服务商：自动填充预设的 base_url / 模型名（未设置 / Mock 清空字段）
  const pickProvider = (
    kind: "llm" | "image",
    provider: string
  ) => {
    const isPreset = provider !== "" && provider !== "mock";
    const preset = providers[provider];
    if (kind === "llm") {
      setLlm({
        provider,
        api_key: "",
        base_url: isPreset ? preset?.base_url || "" : "",
        model: isPreset ? preset?.llm_model || "" : "",
      });
    } else {
      setImage({
        provider,
        api_key: "",
        base_url: isPreset ? preset?.base_url || "" : "",
        model: isPreset ? preset?.image_model || "" : "",
        stream_model: isPreset ? preset?.stream_model || "" : "",
      });
    }
    setTestResult({});
  };

  const buildPayload = () => ({ llm, image });

  const handleTest = async () => {
    setTesting(true);
    setErrorMsg("");
    setNotice("");
    try {
      const result = await testSettings(buildPayload());
      setTestResult(result);
    } catch (e) {
      setErrorMsg("测试失败：" + (e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setErrorMsg("");
    setNotice("");
    try {
      const res = await saveSettings(buildPayload());
      setNotice(res.message);
      onSaved(res.settings);
      // 稍作停留后自动关闭
      setTimeout(onClose, 600);
    } catch (e) {
      setErrorMsg("保存失败：" + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setErrorMsg("");
    setNotice("");
    try {
      const res = await resetSettings();
      setLlm(res.settings.llm);
      setImage(res.settings.image);
      setNotice(res.message);
      onSaved(res.settings);
    } catch (e) {
      setErrorMsg("恢复失败：" + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const providerOptions = (kind: "llm" | "image") => {
    const entries = Object.entries(providers).filter(
      ([key, preset]) =>
        kind === "llm" || preset.image_api !== null || key === "custom"
    );
    return entries;
  };

  const resultStyle = (r?: TestResult): React.CSSProperties => ({
    fontSize: 12,
    marginTop: 4,
    color: r ? (r.ok ? "#4ade80" : "#f87171") : "#888",
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 560,
          maxWidth: "92vw",
          maxHeight: "88vh",
          overflowY: "auto",
          background: "rgba(26,26,46,0.98)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 12,
          padding: "18px 20px 16px",
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
        }}
      >
        {/* 标题 */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 600, color: "#fff" }}>
            ⚙ 大模型设置
          </span>
          <span
            onClick={onClose}
            style={{ color: "#888", fontSize: 13, cursor: "pointer" }}
          >
            ✕
          </span>
        </div>
        <div style={{ color: "#777", fontSize: 12 }}>
          对话模型与图片生成可分别使用不同服务商，保存后立即生效（无需重启）
        </div>

        {/* ===== 对话模型 ===== */}
        <div style={sectionTitleStyle}>
          💬 对话模型（Agent 大脑）
        </div>
        <label style={labelStyle}>服务商</label>
        <select
          className="ic-select"
          style={inputStyle}
          value={llm.provider}
          onChange={(e) => pickProvider("llm", e.target.value)}
        >
          <option value="">{UNSET_LABEL}</option>
          <option value="mock">{MOCK_LABEL}</option>
          {providerOptions("llm").map(([key, preset]) => (
            <option key={key} value={key}>
              {preset.name}
            </option>
          ))}
        </select>

        {llm.provider !== "" && llm.provider !== "mock" && (
          <>
            <label style={labelStyle}>API Key</label>
            <input
              style={inputStyle}
              type="password"
              placeholder="sk-..."
              value={llm.api_key}
              onChange={(e) => setLlm({ ...llm, api_key: e.target.value })}
            />
            <label style={labelStyle}>
              Base URL{llm.provider === "custom" ? "（必填）" : ""}
            </label>
            <input
              style={inputStyle}
              placeholder="https://api.example.com/v1"
              value={llm.base_url}
              onChange={(e) => setLlm({ ...llm, base_url: e.target.value })}
            />
            <label style={labelStyle}>模型名称</label>
            <input
              style={inputStyle}
              placeholder="模型 ID"
              value={llm.model}
              onChange={(e) => setLlm({ ...llm, model: e.target.value })}
            />
          </>
        )}
        {testResult.llm && (
          <div style={resultStyle(testResult.llm)}>
            {testResult.llm.ok ? "✓ " : "✗ "}
            {testResult.llm.message}
          </div>
        )}

        {/* ===== 图片生成 ===== */}
        <div style={sectionTitleStyle}>
          🖼️ 图片生成模型
        </div>
        <label style={labelStyle}>服务商</label>
        <select
          className="ic-select"
          style={inputStyle}
          value={image.provider}
          onChange={(e) => pickProvider("image", e.target.value)}
        >
          <option value="">{UNSET_LABEL}</option>
          <option value="mock">{MOCK_LABEL}</option>
          {providerOptions("image").map(([key, preset]) => (
            <option key={key} value={key}>
              {preset.name}
            </option>
          ))}
        </select>

        {image.provider !== "" && image.provider !== "mock" && (
          <>
            <label style={labelStyle}>API Key</label>
            <input
              style={inputStyle}
              type="password"
              placeholder="sk-..."
              value={image.api_key}
              onChange={(e) => setImage({ ...image, api_key: e.target.value })}
            />
            <label style={labelStyle}>
              Base URL{image.provider === "custom" ? "（必填）" : ""}
            </label>
            <input
              style={inputStyle}
              placeholder="https://api.example.com/v1"
              value={image.base_url}
              onChange={(e) => setImage({ ...image, base_url: e.target.value })}
            />
            <label style={labelStyle}>模型名称（编辑 / 变体 / 组合用）</label>
            <input
              style={inputStyle}
              placeholder="模型 ID"
              value={image.model}
              onChange={(e) => setImage({ ...image, model: e.target.value })}
            />
            {providers[image.provider]?.image_api === "ark" && (
              <>
                <label style={labelStyle}>流式模型（图片容器生成用，留空回退非流式）</label>
                <input
                  style={inputStyle}
                  placeholder="模型 ID"
                  value={image.stream_model}
                  onChange={(e) =>
                    setImage({ ...image, stream_model: e.target.value })
                  }
                />
              </>
            )}
          </>
        )}
        {testResult.image && (
          <div style={resultStyle(testResult.image)}>
            {testResult.image.ok ? "✓ " : "✗ "}
            {testResult.image.message}
          </div>
        )}

        {/* 提示信息 */}
        {errorMsg && (
          <div style={{ color: "#f87171", fontSize: 12, marginTop: 12 }}>
            {errorMsg}
          </div>
        )}
        {notice && (
          <div style={{ color: "#4ade80", fontSize: 12, marginTop: 12 }}>
            {notice}
          </div>
        )}

        {/* 操作按钮 */}
        <div
          style={{
            display: "flex",
            gap: 10,
            marginTop: 18,
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={handleReset}
            disabled={saving || testing}
            style={{
              ...inputStyle,
              width: "auto",
              padding: "8px 14px",
              cursor: "pointer",
              background: "transparent",
              color: "#999",
            }}
          >
            恢复默认
          </button>
          <button
            onClick={handleTest}
            disabled={saving || testing}
            style={{
              ...inputStyle,
              width: "auto",
              padding: "8px 14px",
              cursor: "pointer",
              background: "rgba(255,255,255,0.08)",
              color: "#ddd",
            }}
          >
            {testing ? "测试中..." : "测试连接"}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || testing}
            style={{
              ...inputStyle,
              width: "auto",
              padding: "8px 18px",
              cursor: "pointer",
              background: "rgba(99,102,241,0.85)",
              borderColor: "rgba(99,102,241,0.9)",
              color: "#fff",
              fontWeight: 600,
            }}
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>

        {/* select 下拉选项深色样式 */}
        <style>{SELECT_CSS}</style>
      </div>
    </div>
  );
}
