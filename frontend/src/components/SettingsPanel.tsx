import { useEffect, useRef, useState } from "react";
import {
  getSettings,
  getProviders,
  saveSettings,
  resetSettings,
  testSettings,
  listExperiences,
  addExperience,
  updateExperience,
  deleteExperience,
  type AppSettingsData,
  type LLMSettings,
  type ImageSettings,
  type ProviderPreset,
  type TestResult,
  type ExperienceMeta,
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

  // ===== 风格库（经验文档）=====
  const [experiences, setExperiences] = useState<ExperienceMeta[]>([]);
  const [expNotice, setExpNotice] = useState("");
  const [importDraft, setImportDraft] = useState<{
    name: string;
    description: string;
    content: string;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 加载风格列表 + 服务商预设
  useEffect(() => {
    (async () => {
      try {
        const [settings, providerData, exps] = await Promise.all([
          getSettings(),
          getProviders(),
          listExperiences().catch(() => [] as ExperienceMeta[]),
        ]);
        setLlm(settings.llm);
        setImage(settings.image);
        setProviders(providerData.providers);
        setExperiences(exps);
      } catch (e) {
        setErrorMsg("加载配置失败：" + (e as Error).message);
      }
    })();
  }, []);

  // 选择 MD 文件 → 打开导入表单（名称/描述自动预填，可编辑）
  const handlePickFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const content = await file.text();
      if (!content.trim()) {
        setExpNotice("文件内容为空");
        return;
      }
      const autoName = file.name.replace(/\.(md|markdown|txt)$/i, "");
      const plain = content
        .replace(/[#*`>\-\[\]()!_~|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const autoDesc = plain.slice(0, 100) + (plain.length > 100 ? "…" : "");
      setImportDraft({ name: autoName, description: autoDesc, content });
      setExpNotice("");
    } catch {
      setExpNotice("读取文件失败");
    }
  };

  // 确认导入 → 立即生效（后端写文件 + 注册，热加载）
  const handleImport = async () => {
    if (!importDraft) return;
    setImporting(true);
    try {
      await addExperience(importDraft.name, importDraft.description, importDraft.content);
      const exps = await listExperiences();
      setExperiences(exps);
      setImportDraft(null);
      setExpNotice(`已导入《${importDraft.name}》，生成图片时可在面板风格中选择`);
      setTimeout(() => setExpNotice(""), 2600);
    } catch (e) {
      setExpNotice("导入失败：" + (e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  // 删除风格
  const handleDeleteExp = async (id: string, name: string) => {
    if (editDraft?.id === id) setEditDraft(null); // 正在编辑的项被删除，关闭表单
    try {
      await deleteExperience(id);
      setExperiences((prev) => prev.filter((e) => e.id !== id));
      setExpNotice(`已删除《${name}》`);
      setTimeout(() => setExpNotice(""), 2600);
    } catch {
      setExpNotice("删除失败");
    }
  };

  // ===== 编辑风格名称/描述 =====
  const [editDraft, setEditDraft] = useState<{
    id: string;
    name: string;
    description: string;
  } | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const handleEditSave = async () => {
    if (!editDraft || !editDraft.name.trim()) return;
    setEditSaving(true);
    try {
      const updated = await updateExperience(editDraft.id, {
        name: editDraft.name.trim(),
        description: editDraft.description.trim(),
      });
      setExperiences((prev) =>
        prev.map((e) => (e.id === updated.id ? { ...e, ...updated } : e))
      );
      const done = editDraft.name.trim();
      setEditDraft(null);
      setExpNotice(`已更新《${done}》`);
      setTimeout(() => setExpNotice(""), 2600);
    } catch (e) {
      setExpNotice("保存失败：" + (e as Error).message);
    } finally {
      setEditSaving(false);
    }
  };

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

        {/* ===== 风格库（经验文档） ===== */}
        <div style={sectionTitleStyle}>🎨 风格库（风格指南）</div>
        <div style={{ color: "#777", fontSize: 12, margin: "4px 0 8px" }}>
          导入设计师总结的风格 MD，生成图片时可在面板中选择；Agent 对话也会按需引用
        </div>

        {/* 风格列表 */}
        {experiences.length === 0 && !importDraft && (
          <div style={{ color: "#666", fontSize: 12, padding: "6px 0" }}>
            暂无风格，点击下方按钮导入第一个
          </div>
        )}
        {experiences.map((exp) =>
          // 编辑态：名称/描述表单（保存调 PUT，改正文需删了重导）
          editDraft?.id === exp.id ? (
            <div
              key={exp.id}
              style={{
                marginTop: 6,
                padding: 10,
                background: "rgba(167,139,250,0.06)",
                borderRadius: 6,
                border: "1px solid rgba(167,139,250,0.25)",
              }}
            >
              <label style={labelStyle}>风格名称</label>
              <input
                style={inputStyle}
                value={editDraft.name}
                onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                autoFocus
              />
              <label style={labelStyle}>一句话描述（Agent 按此判断何时使用）</label>
              <input
                style={inputStyle}
                value={editDraft.description}
                onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                placeholder="如：低饱和暖色、晕染、留白，适合儿童绘本"
              />
              <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                <button
                  onClick={() => setEditDraft(null)}
                  disabled={editSaving}
                  style={{
                    ...inputStyle,
                    width: "auto",
                    padding: "7px 12px",
                    cursor: "pointer",
                    background: "transparent",
                    color: "#999",
                  }}
                >
                  取消
                </button>
                <button
                  onClick={handleEditSave}
                  disabled={editSaving || !editDraft.name.trim()}
                  style={{
                    ...inputStyle,
                    width: "auto",
                    padding: "7px 12px",
                    cursor: "pointer",
                    background: "rgba(167,139,250,0.25)",
                    color: "#eee",
                  }}
                >
                  {editSaving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
          ) : (
            <div
              key={exp.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "7px 10px",
                marginTop: 6,
                background: "rgba(255,255,255,0.04)",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "#ddd", fontSize: 13, fontWeight: 600 }}>
                  {exp.name}
                </div>
                <div style={{ color: "#888", fontSize: 12, marginTop: 2, wordBreak: "break-word" }}>
                  {exp.description || "（无描述，Agent 判断匹配时可能不准，建议补一句适用场景）"}
                </div>
              </div>
              <button
                onClick={() =>
                  setEditDraft({ id: exp.id, name: exp.name, description: exp.description })
                }
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#a78bfa",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: "2px 4px",
                  whiteSpace: "nowrap",
                }}
                title={`编辑《${exp.name}》的名称/描述`}
              >
                编辑
              </button>
              <button
                onClick={() => handleDeleteExp(exp.id, exp.name)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#f87171",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: "2px 4px",
                  whiteSpace: "nowrap",
                }}
                title={`删除《${exp.name}》`}
              >
                删除
              </button>
            </div>
          )
        )}

        {/* 导入表单：选文件后出现，名称/描述可编辑 */}
        {importDraft ? (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              background: "rgba(167,139,250,0.06)",
              borderRadius: 6,
              border: "1px solid rgba(167,139,250,0.25)",
            }}
          >
            <label style={labelStyle}>风格名称</label>
            <input
              style={inputStyle}
              value={importDraft.name}
              onChange={(e) => setImportDraft({ ...importDraft, name: e.target.value })}
              placeholder="如：赛博朋克海报"
            />
            <label style={labelStyle}>一句话描述（Agent 按此判断何时使用）</label>
            <input
              style={inputStyle}
              value={importDraft.description}
              onChange={(e) => setImportDraft({ ...importDraft, description: e.target.value })}
              placeholder="如：霓虹、雨夜、高对比、科技感，适合未来题材海报"
            />
            <div
              style={{
                marginTop: 8,
                maxHeight: 120,
                overflowY: "auto",
                padding: "6px 8px",
                background: "rgba(0,0,0,0.25)",
                borderRadius: 6,
                color: "#999",
                fontSize: 11,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {importDraft.content.slice(0, 500)}
              {importDraft.content.length > 500 ? "\n…" : ""}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setImportDraft(null)}
                disabled={importing}
                style={{
                  ...inputStyle,
                  width: "auto",
                  padding: "7px 12px",
                  cursor: "pointer",
                  background: "transparent",
                  color: "#999",
                }}
              >
                取消
              </button>
              <button
                onClick={handleImport}
                disabled={importing || !importDraft.name.trim()}
                style={{
                  ...inputStyle,
                  width: "auto",
                  padding: "7px 12px",
                  cursor: "pointer",
                  background: "rgba(167,139,250,0.25)",
                  color: "#eee",
                }}
              >
                {importing ? "导入中..." : "确认导入"}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            style={{
              ...inputStyle,
              marginTop: 10,
              cursor: "pointer",
              background: "rgba(255,255,255,0.08)",
              color: "#ddd",
            }}
          >
            📁 导入风格 MD 文件
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // 允许重复选同一个文件
            handlePickFile(f);
          }}
        />
        {expNotice && (
          <div style={{ color: "#a78bfa", fontSize: 12, marginTop: 8 }}>{expNotice}</div>
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
