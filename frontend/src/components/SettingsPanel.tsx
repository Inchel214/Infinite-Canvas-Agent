import { useEffect, useRef, useState } from "react";
import "./SettingsPanel.css";
import { SettingsNavIcon } from "./SettingsNavIcon";
import {
  getSettings,
  getProviders,
  saveSettings,
  testSettings,
  listModels,
  listExperiences,
  getExperience,
  addExperience,
  updateExperience,
  deleteExperience,
  listMemory,
  updateMemory,
  deleteMemory,
  listProfiles,
  deleteProfile,
  type AppSettingsData,
  type LLMSettings,
  type ImageSettings,
  type ModelsQueryResult,
  type ProviderPreset,
  type TestResult,
  type ExperienceMeta,
  type MemoryItem,
  type SavedProfile,
  type SavedProfiles,
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

// 模型名称字段：输入框 + 查询按钮，查询成功后下方弹出深色候选列表点选
function ModelField(props: {
  value: string;
  onChange: (v: string) => void;
  fetchModels: () => Promise<ModelsQueryResult>;
  placeholder?: string;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 点击组件外部收起候选列表
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const handleQuery = async () => {
    setLoading(true);
    setHint("");
    try {
      const res = await props.fetchModels();
      setModels(res.models);
      if (res.models.length > 0) {
        setOpen(true);
        setHint(res.message || `已获取 ${res.models.length} 个模型，点击选择`);
      } else {
        setOpen(false);
        setHint(res.message || "未查询到模型，请手动输入");
      }
    } catch (e) {
      setModels([]);
      setOpen(false);
      setHint("查询失败：" + (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          style={{ ...inputStyle, flex: 1 }}
          placeholder={props.placeholder || "模型 ID"}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <button
          onClick={handleQuery}
          disabled={loading}
          title="查询该服务商的可用模型列表"
          style={{
            ...inputStyle,
            width: "auto",
            padding: "7px 10px",
            cursor: "pointer",
            whiteSpace: "nowrap",
            background: "rgba(167,139,250,0.2)",
            borderColor: "rgba(167,139,250,0.35)",
            color: "#cfc6f7",
          }}
        >
          {loading ? "查询中…" : "⟳ 查询"}
        </button>
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: "#888", marginTop: 3 }}>{hint}</div>
      )}
      {open && models.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            maxHeight: 220,
            overflowY: "auto",
            background: "#232342",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 6,
            marginTop: 2,
            zIndex: 100,
            boxShadow: "0 8px 24px rgba(0,0,0,0.55)",
          }}
        >
          {models.map((m) => (
            <div
              key={m}
              onClick={() => {
                props.onChange(m);
                setOpen(false);
              }}
              title={m}
              style={{
                padding: "7px 10px",
                color: "#ddd",
                fontSize: 12,
                cursor: "pointer",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(167,139,250,0.15)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 已保存连接折叠展示，恢复与删除使用独立按钮。
function SavedProfileChips(props: {
  items: SavedProfile[];
  onPick: (p: SavedProfile) => void;
  onDelete: (p: SavedProfile) => void;
}) {
  if (props.items.length === 0) return null;
  return <details className="settings-profiles">
    <summary>切换已保存的连接 <span>{props.items.length}</span></summary>
    <div>{props.items.map(p => <div className="settings-profile-row" key={p.id}>
      <button onClick={e => {props.onPick(p); e.currentTarget.closest("details")?.removeAttribute("open");}} title={p.base_url}><strong>{p.model || p.provider_name}</strong><span>{p.provider_name} · {p.base_url}</span></button>
      <button aria-label={`删除已保存连接 ${p.model}`} onClick={() => {if (window.confirm(`删除已保存的连接 ${p.model}？不会更改当前正在使用的配置。`)) props.onDelete(p);}}>删除</button>
    </div>)}</div>
  </details>;
}

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
  const [testing, setTesting] = useState<"llm" | "image" | null>(null);
  const [tab, setTab] = useState<"models" | "skills" | "memory">("models");
  const [modelKind, setModelKind] = useState<"llm" | "image">("llm");
  const [search, setSearch] = useState("");
  const [skillKind, setSkillKind] = useState("all");
  const [loading, setLoading] = useState(true);
  const [baseline, setBaseline] = useState({llm: "", image: ""});
  const currentConfig = useRef({llm: "", image: ""});
  useEffect(() => { currentConfig.current = {llm: JSON.stringify(llm), image: JSON.stringify(image)}; }, [llm, image]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestClose = () => {
    const dirty = (!loading && (baseline.llm !== JSON.stringify(llm) || baseline.image !== JSON.stringify(image))) || !!editDraft || !!importDraft || memories.some(m => memoryDrafts[m.id] !== m.text);
    if (!dirty || window.confirm("有尚未保存的修改，确定关闭？")) onClose();
  };
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState<SavedProfiles>({ llm: [], image: [] });
  const [testResult, setTestResult] = useState<{
    llm?: TestResult & {fingerprint: string};
    image?: TestResult & {fingerprint: string};
  }>({});
  const [errorMsg, setErrorMsg] = useState("");
  const [notice, setNotice] = useState("");

  // ===== 我的偏好（跨画布记忆）=====
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [memoryDrafts, setMemoryDrafts] = useState<Record<string, string>>({});
  const [memoryNotice, setMemoryNotice] = useState("");
  const [memoryPending, setMemoryPending] = useState<{
    id: string;
    action: "save" | "delete";
  } | null>(null);

  // ===== 技能库（提示词技能）=====
  const [experiences, setExperiences] = useState<ExperienceMeta[]>([]);
  const [expNotice, setExpNotice] = useState("");
  const [importDraft, setImportDraft] = useState<{
    name: string;
    description: string;
    content: string;
  } | null>(null);
  const [draftSource, setDraftSource] = useState<"file" | "manual" | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 加载技能列表 + 服务商预设 + 已保存配置历史 + 跨画布偏好
  useEffect(() => {
    (async () => {
      try {
        const [settings, providerData, exps, savedProfiles, memoryItems] = await Promise.all([
          getSettings(),
          getProviders(),
          listExperiences().catch(() => [] as ExperienceMeta[]),
          listProfiles().catch(() => ({ llm: [], image: [] }) as SavedProfiles),
          listMemory().catch(() => [] as MemoryItem[]),
        ]);
        setBaseline({llm: JSON.stringify(settings.llm), image: JSON.stringify(settings.image)});
        setLlm(settings.llm);
        setImage(settings.image);
        setProviders(providerData.providers);
        setExperiences(exps);
        setProfiles(savedProfiles);
        setMemories(memoryItems);
        setMemoryDrafts(Object.fromEntries(memoryItems.map((item) => [item.id, item.text])));
      } catch (e) {
        setErrorMsg("加载配置失败：" + (e as Error).message);
      } finally { setLoading(false); }
    })();
  }, []);

  const handleSaveMemory = async (item: MemoryItem) => {
    const text = (memoryDrafts[item.id] ?? item.text).trim();
    if (!text) return;
    setMemoryPending({ id: item.id, action: "save" });
    setMemoryNotice("");
    try {
      const updated = await updateMemory(item.id, text);
      setMemories((prev) =>
        prev.map((memory) => (memory.id === item.id ? updated : memory))
      );
      setMemoryDrafts((prev) => ({ ...prev, [item.id]: updated.text }));
      setMemoryNotice("偏好已保存");
    } catch (e) {
      setMemoryNotice("保存偏好失败：" + (e as Error).message);
    } finally {
      setMemoryPending(null);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    setMemoryPending({ id, action: "delete" });
    setMemoryNotice("");
    try {
      await deleteMemory(id);
      setMemories((prev) => prev.filter((item) => item.id !== id));
      setMemoryDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setMemoryNotice("偏好已删除");
    } catch (e) {
      setMemoryNotice("删除偏好失败：" + (e as Error).message);
    } finally {
      setMemoryPending(null);
    }
  };

  // 选择 MD 文件 → 打开导入表单（名称/描述自动预填，可编辑）
  const handlePickFile = async (file: File | undefined) => {
    if (!file) return;
    if ((editDraft || importDraft) && !window.confirm("放弃当前技能的未保存修改？")) return;
    setEditDraft(null);
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
      setDraftSource("file");
      setExpNotice("");
    } catch {
      setExpNotice("读取文件失败");
    }
  };

  // 手动新建/文件导入共用保存链路：后端写成独立 MD 并热加载。
  const handleSaveExperience = async () => {
    if (!importDraft) return;
    setImporting(true);
    try {
      await addExperience(importDraft.name, importDraft.description, importDraft.content);
      const exps = await listExperiences();
      setExperiences(exps);
      setImportDraft(null);
      setDraftSource(null);
      setExpNotice(
        draftSource === "manual"
          ? `已保存《${importDraft.name}》为 MD，生成图片时可直接选择`
          : `已导入《${importDraft.name}》，生成图片时可在面板技能中选择`
      );
      setTimeout(() => setExpNotice(""), 2600);
    } catch (e) {
      setExpNotice(`${draftSource === "manual" ? "保存" : "导入"}失败：${(e as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  // 删除技能
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

  // ===== 编辑技能名称、用途与正文 =====
  const [editDraft, setEditDraft] = useState<{
    id: string;
    name: string;
    description: string;
    content: string;
  } | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const handleEditSave = async () => {
    if (!editDraft || !editDraft.name.trim()) return;
    setEditSaving(true);
    try {
      const updated = await updateExperience(editDraft.id, {
        name: editDraft.name.trim(),
        description: editDraft.description.trim(),
        content: editDraft.content,
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

  // Keep keyboard focus inside the settings dialog; restore it to the entry on exit.
  const closeRef = useRef(requestClose);
  useEffect(() => { closeRef.current = requestClose; });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); }
      if (e.key !== "Tab") return;
      const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? []).filter(el => el.getClientRects().length);
      if (!nodes.length) { e.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); previous?.focus(); };
  }, []);

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
        ...image,
        provider,
        api_key: "",
        secret_key: "",
        liblib_reference_mode: "subject",
        liblib_steps: 30,
        base_url: isPreset ? preset?.base_url || "" : "",
        model: isPreset ? preset?.image_model || "" : "",
        stream_model: isPreset ? preset?.stream_model || "" : "",
      });
    }
    setTestResult({});
  };

  // 点击已保存配置 → 整组回填（Key 为脱敏串，保存时后端按历史还原真实 Key）
  const handlePickProfile = (kind: "llm" | "image", p: SavedProfile) => {
    if (kind === "llm") {
      setLlm({
        provider: p.provider,
        api_key: p.api_key,
        base_url: p.base_url,
        model: p.model,
      });
    } else {
      setImage((prev) => ({
        ...prev,
        source: "api",
        secret_key: p.secret_key || "",
        liblib_reference_mode: p.liblib_reference_mode || "subject",
        liblib_steps: p.liblib_steps || 30,
        provider: p.provider,
        api_key: p.api_key,
        base_url: p.base_url,
        model: p.model,
        stream_model: p.stream_model,
      }));
    }
    setTestResult({});
    setNotice("");
  };

  const handleDeleteProfile = async (kind: "llm" | "image", p: SavedProfile) => {
    try {
      await deleteProfile(kind, p.id);
      setProfiles((prev) => ({
        ...prev,
        [kind]: prev[kind].filter((item) => item.id !== p.id),
      }));
    } catch (e) {
      setErrorMsg("删除已保存配置失败：" + (e as Error).message);
    }
  };

  const handleTest = async () => {
    const kind = modelKind;
    const fingerprint = currentConfig.current[kind];
    setTesting(kind);
    setErrorMsg("");
    try {
      const result = await testSettings({ llm, image }, kind);
      if (currentConfig.current[kind] === fingerprint) setTestResult(prev => ({...prev, [kind]: {...result[kind], fingerprint}}));
    } catch (e) {
      if (currentConfig.current[kind] === fingerprint) setTestResult(prev => ({...prev, [kind]: {ok: false, message: "测试失败：" + (e as Error).message, fingerprint}}));
    } finally { setTesting(null); }
  };

  const handleSave = async () => {
    const kind = modelKind;
    const draft = kind === "llm" ? llm : image;
    setSaving(true);
    setErrorMsg("");
    setNotice("");
    try {
      // Only commit this connection. Another tab's unsaved draft stays unsaved.
      const latest = await getSettings();
      const res = await saveSettings({ llm: latest.llm, image: latest.image, [kind]: draft });
      if (kind === "llm") setLlm(res.settings.llm); else setImage(res.settings.image);
      setBaseline(prev => ({...prev, [kind]: JSON.stringify(res.settings[kind])}));
      setNotice(`${kind === "llm" ? "对话" : "图片"}配置已保存`);
      onSaved(res.settings);
      listProfiles().then(setProfiles).catch(() => {});
    } catch (e) { setErrorMsg("保存失败：" + (e as Error).message); }
    finally { setSaving(false); }
  };

  const openSkill = async (id: string) => {
    if ((editDraft || importDraft) && !window.confirm("放弃当前技能的未保存修改？")) return;
    try {
      const item = await getExperience(id);
      setImportDraft(null);
      setEditDraft({id, name: item.name, description: item.description, content: item.content});
      setExpNotice("");
    } catch (e) { setExpNotice("读取技能失败：" + (e as Error).message); }
  };

  const providerOptions = (kind: "llm" | "image") => {
    const entries = Object.entries(providers).filter(
      ([key, preset]) =>
        kind === "llm" ? preset.llm_api !== null : preset.image_api !== null || key === "custom"
    );
    return entries;
  };

  const filteredSkills = experiences.filter(exp =>
    (skillKind === "all" || (exp.kind || "style") === skillKind) &&
    `${exp.name} ${exp.description}`.toLowerCase().includes(search.toLowerCase())
  );
  const dirty = baseline[modelKind] !== JSON.stringify(modelKind === "llm" ? llm : image);
  const candidateResult = testResult[modelKind];
  const activeResult = candidateResult?.fingerprint === JSON.stringify(modelKind === "llm" ? llm : image) ? candidateResult : undefined;

  return (
    <div className="settings-overlay" onMouseDown={e => { if (e.target === e.currentTarget) requestClose(); }}>
      <div className="settings-shell" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={dialogRef}>
        <header className="settings-header">
          <h2 id="settings-title">设置</h2>
          <button className="settings-close" aria-label="关闭设置" onClick={requestClose}>×</button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="设置分类">
            <button aria-current={tab === "models" ? "page" : undefined} onClick={() => {setTab("models");setNotice("");}}><SettingsNavIcon name="models" />模型与服务</button>
            <button aria-current={tab === "skills" ? "page" : undefined} onClick={() => {setTab("skills");setNotice("");}}><SettingsNavIcon name="skills" />技能库 <small>{experiences.length}</small></button>
            <button aria-current={tab === "memory" ? "page" : undefined} onClick={() => {setTab("memory");setNotice("");}}><SettingsNavIcon name="memory" />偏好与记忆</button>
            <div className="settings-nav-note">Infinite Canvas</div>
          </nav>
          <div className="settings-workspace">
            {loading ? <div className="settings-empty" role="status">正在加载设置…</div> : <>
            {tab === "models" && <>
              <div className="settings-page-heading"><div><h3>模型与服务</h3><p>分别配置对话与图片生成使用的连接。</p></div></div>
              <div className="settings-model-switch" role="group" aria-label="连接类型">
                <button aria-pressed={modelKind === "llm"} onClick={() => {setModelKind("llm");setNotice("");}}><span>对话模型</span><strong>{llm.model || "跟随环境配置"}</strong></button>
                <button aria-pressed={modelKind === "image"} onClick={() => {setModelKind("image");setNotice("");}}><span>图片生成</span><strong>{image.source === "openart" ? image.openart_model || "nano-banana-2" : image.model || "跟随环境配置"}</strong></button>
              </div>
              <div className="settings-scroll settings-connection">
                <fieldset disabled={saving || testing !== null}>
                  {modelKind === "llm" ? <>
        {/* ===== 对话模型 ===== */}
        <div style={sectionTitleStyle}>
          对话连接
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

        <SavedProfileChips
          items={profiles.llm}
          onPick={(p) => handlePickProfile("llm", p)}
          onDelete={(p) => handleDeleteProfile("llm", p)}
        />

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
            <ModelField
              value={llm.model}
              onChange={(v) => setLlm({ ...llm, model: v })}
              fetchModels={() =>
                listModels({
                  kind: "llm",
                  provider: llm.provider,
                  api_key: llm.api_key,
                  base_url: llm.base_url,
                })
              }
            />
          </>
        )}
                  </> : <>
        {/* ===== 图片生成 ===== */}
        <div style={sectionTitleStyle}>
          图片连接
        </div>
        <label style={labelStyle}>生图来源</label>
        <select
          aria-label="生图来源"
          className="ic-select"
          style={inputStyle}
          value={image.source || "api"}
          onChange={(e) => {
            setImage({ ...image, source: e.target.value as "api" | "openart" });
            setTestResult({});
          }}
        >
          <option value="api">原有 API</option>
          <option value="openart">OpenArt（使用登录账号）</option>
        </select>

        {image.source === "openart" ? (
          <>
            <div style={{ color: "#999", fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
              使用本机 OpenArt 登录账号，生图消耗该账号点数。原有 API 配置会保留，可随时切回。
              <br />
              按所选比例与分辨率生成（以模型支持范围为准）；不支持蒙版局部编辑。
            </div>
            <label style={labelStyle}>OpenArt 模型</label>
            <ModelField
              value={image.openart_model || "nano-banana-2"}
              onChange={(v) => setImage({ ...image, openart_model: v })}
              fetchModels={() => listModels({ kind: "image", provider: "openart", api_key: "", base_url: "" })}
            />
            <div style={{ color: "#999", fontSize: 12, marginTop: 6 }}>
              未登录时，请先在终端运行 openart login。
            </div>
          </>
        ) : (
          <>
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

        <SavedProfileChips
          items={profiles.image}
          onPick={(p) => handlePickProfile("image", p)}
          onDelete={(p) => handleDeleteProfile("image", p)}
        />

        {image.provider !== "" && image.provider !== "mock" && (
          <>
            <label style={labelStyle}>{image.provider === "liblib" ? "AccessKey" : "API Key"}</label>
            <input
              style={inputStyle}
              type="password"
              placeholder={image.provider === "liblib" ? "Liblib AccessKey" : "sk-..."}
              value={image.api_key}
              onChange={(e) => setImage({ ...image, api_key: e.target.value })}
            />
            {image.provider === "liblib" && (
              <>
                <label style={labelStyle}>SecretKey</label>
                <input style={inputStyle} type="password" autoComplete="off"
                  placeholder="Liblib SecretKey" value={image.secret_key || ""}
                  onChange={(e) => setImage({ ...image, secret_key: e.target.value })} />
                <label style={labelStyle}>参考图用法</label>
                <select style={inputStyle} value={image.liblib_reference_mode || "subject"}
                  onChange={(e) => setImage({ ...image, liblib_reference_mode: e.target.value as "subject" | "img2img" })}>
                  <option value="subject">主体参考（实验性，测试返回上游异常）</option>
                  <option value="img2img">图生图（整体重绘，尚未实测）</option>
                </select>
                <label style={labelStyle}>采样步数</label>
                <select style={inputStyle} value={image.liblib_steps || 30}
                  onChange={(e) => setImage({ ...image, liblib_steps: Number(e.target.value) as 20 | 30 })}>
                  <option value={30}>30 步（文档建议）</option>
                  <option value={20}>20 步</option>
                </select>
                <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>
                  请使用英文提示词。支持文生图和 1K / 2K。主体参考实测返回 Liblib 执行异常，暂未验证可用。
                  图生图尺寸跟随参考图；暂不支持多图组合、蒙版和草图局部编辑。
                </div>
              </>
            )}
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
            <ModelField
              value={image.model}
              onChange={(v) => setImage({ ...image, model: v })}
              fetchModels={() =>
                listModels({
                  kind: "image",
                  provider: image.provider,
                  api_key: image.api_key,
                  base_url: image.base_url,
                })
              }
            />
            {providers[image.provider]?.image_api === "ark" && (
              <>
                <label style={labelStyle}>流式模型（图片容器生成用，留空回退非流式）</label>
                <ModelField
                  value={image.stream_model}
                  onChange={(v) => setImage({ ...image, stream_model: v })}
                  fetchModels={() =>
                    listModels({
                      kind: "image",
                      provider: image.provider,
                      api_key: image.api_key,
                      base_url: image.base_url,
                    })
                  }
                />
              </>
            )}
          </>
        )}
          </>
        )}
                  </>}
                </fieldset>
              </div>
              <footer className="settings-connection-footer">
                <div className="settings-test-status" role="status" data-state={activeResult ? activeResult.ok ? "success" : "error" : "idle"}>
                  {testing === modelKind ? "正在测试当前连接…" : activeResult ? activeResult.message : "当前配置尚未测试"}
                  <small>{modelKind === "image" ? "连接测试不生成图片；模型效果请在画布中验证。" : "发送一条最小对话请求验证，不保存配置。"}</small>
                </div>
                <div className="settings-actions">
                  <button disabled={saving || testing !== null} onClick={handleTest}>{testing === modelKind ? "测试中…" : "测试当前连接"}</button>
                  <button className="primary" disabled={saving || testing !== null || !dirty} onClick={handleSave}>{saving ? "保存中…" : "保存此连接"}</button>
                </div>
              </footer>
            </>}
            {tab === "skills" && <>
              <div className="settings-page-heading"><div><h3>技能库</h3><p>管理可在对话和图片生成中调用的提示词。</p></div><div className="settings-actions">
                <button onClick={() => fileInputRef.current?.click()}>导入 MD</button>
                <button className="primary" onClick={() => {if ((editDraft || importDraft) && !window.confirm("放弃当前技能的未保存修改？")) return; setEditDraft(null);setImportDraft({name:"",description:"",content:""});setDraftSource("manual");}}>＋ 新建</button>
              </div></div>
              <div className="settings-skill-tools"><input aria-label="搜索技能" placeholder="搜索名称或用途…" value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="筛选技能类型" value={skillKind} onChange={e => setSkillKind(e.target.value)}><option value="all">全部类型</option><option value="style">风格指南</option><option value="preset">场景预设</option></select></div>
              <div className="settings-scroll settings-skills">
                {!importDraft && !editDraft && <div className="settings-skill-list">
                  {filteredSkills.map(exp => <div className="settings-skill-row" key={exp.id}>
                    <button className="settings-skill-open" onClick={() => openSkill(exp.id)}><strong>{exp.name}</strong><span>{exp.description || "暂无用途描述"}</span></button>
                    {new Set(experiences.map(item => item.kind || "style")).size > 1 && <span className="settings-kind">{exp.kind === "preset" ? "预设" : "风格"}</span>}
                    <details className="settings-skill-menu"><summary aria-label={`管理${exp.name}`}>···</summary><div><button onClick={() => openSkill(exp.id)}>编辑技能</button><button onClick={() => {if (window.confirm(`删除《${exp.name}》？此操作无法撤销。`)) handleDeleteExp(exp.id, exp.name);}}>删除技能</button></div></details>
                  </div>)}
                  {!filteredSkills.length && <div className="settings-empty">{search || skillKind !== "all" ? "没有匹配的技能" : "暂无技能，导入 MD 或新建一个。"}</div>}
                </div>}
                {editDraft && <div className="settings-editor">
                  <div className="settings-editor-heading"><h4>编辑技能</h4><button onClick={() => {if(window.confirm("放弃当前技能的修改？")) setEditDraft(null);}}>返回列表</button></div>
                  <label>技能名称<input value={editDraft.name} onChange={e => setEditDraft({...editDraft,name:e.target.value})} /></label>
                  <label>一句话用途<input value={editDraft.description} onChange={e => setEditDraft({...editDraft,description:e.target.value})} /></label>
                  <label>Markdown 正文<textarea value={editDraft.content} onChange={e => setEditDraft({...editDraft,content:e.target.value})} /></label>
                  <div className="settings-actions"><button className="primary" disabled={editSaving || !editDraft.name.trim() || !editDraft.content.trim()} onClick={handleEditSave}>{editSaving ? "保存中…" : "保存技能"}</button></div>
                </div>}
        {/* 新建/导入表单：手动模式可直接编辑 Markdown 正文 */}
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
            <div style={{ color: "#ddd", fontSize: 13, fontWeight: 650, marginBottom: 8 }}>
              {draftSource === "manual" ? "手动新建技能" : "确认导入技能"}
            </div>
            <label style={labelStyle}>技能名称</label>
            <input
              style={inputStyle}
              value={importDraft.name}
              onChange={(e) => setImportDraft({ ...importDraft, name: e.target.value })}
              placeholder="如：赛博朋克海报"
            />
            {draftSource === "file" && (
              <>
                <label style={labelStyle}>一句话描述（Agent 按此判断何时使用）</label>
                <input
                  style={inputStyle}
                  value={importDraft.description}
                  onChange={(e) => setImportDraft({ ...importDraft, description: e.target.value })}
                  placeholder="如：霓虹、雨夜、高对比、科技感，适合未来题材海报"
                />
              </>
            )}
            <label style={labelStyle}>
              Markdown 正文
              {draftSource === "manual" ? "（保存后自动生成描述）" : "（内容预览）"}
            </label>
            {draftSource === "manual" ? (
              <textarea
                style={{
                  ...inputStyle,
                  minHeight: 170,
                  resize: "vertical",
                  lineHeight: 1.55,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
                value={importDraft.content}
                onChange={(e) => setImportDraft({ ...importDraft, content: e.target.value })}
                placeholder={"# 风格说明\n\n写下色彩、构图、材质、光线和适用场景……"}
                autoFocus
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleSaveExperience();
                }}
              />
            ) : (
              <div
                style={{
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
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setImportDraft(null);
                  setDraftSource(null);
                }}
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
                onClick={handleSaveExperience}
                disabled={
                  importing || !importDraft.name.trim() || !importDraft.content.trim()
                }
                style={{
                  ...inputStyle,
                  width: "auto",
                  padding: "7px 12px",
                  cursor: "pointer",
                  background: "rgba(167,139,250,0.25)",
                  color: "#eee",
                }}
              >
                {importing
                  ? draftSource === "manual"
                    ? "保存中..."
                    : "导入中..."
                  : draftSource === "manual"
                    ? "保存为 MD"
                    : "确认导入"}
              </button>
            </div>
          </div>
        ) : null}
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

              </div>
            </>}
            {tab === "memory" && <><div className="settings-page-heading"><div><h3>偏好与记忆</h3><p>查看和调整 Agent 记住的使用偏好。</p></div></div><div className="settings-scroll settings-memory">
        {/* ===== 我的偏好（跨画布记忆） ===== */}
        <div style={sectionTitleStyle}>已记忆 {memories.length} 条偏好</div>
        <div style={{ color: "#777", fontSize: 12, margin: "4px 0 8px" }}>
          Agent 会在不同画布中参考这些偏好。每条修改独立保存。
        </div>
        {memories.length === 0 ? (
          <div style={{ color: "#666", fontSize: 12, padding: "6px 0" }}>
            暂无记忆偏好
          </div>
        ) : (
          memories.map((item) => {
            const text = memoryDrafts[item.id] ?? item.text;
            const pendingAction = memoryPending?.id === item.id ? memoryPending.action : null;
            return (
              <div
                key={item.id}
                style={{
                  marginTop: 6,
                  padding: 10,
                  background: "rgba(255,255,255,0.04)",
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <textarea
                  aria-label="偏好内容"
                  style={{
                    ...inputStyle,
                    minHeight: 58,
                    resize: "vertical",
                    lineHeight: 1.5,
                  }}
                  value={text}
                  disabled={pendingAction !== null}
                  onChange={(e) =>
                    setMemoryDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))
                  }
                />
                <div style={{ display: "flex", gap: 8, marginTop: 6, justifyContent: "flex-end" }}>
                  <button
                    onClick={() => handleSaveMemory(item)}
                    disabled={memoryPending !== null || !text.trim()}
                    style={{
                      ...inputStyle,
                      width: "auto",
                      padding: "6px 12px",
                      cursor: "pointer",
                      background: "rgba(167,139,250,0.22)",
                      borderColor: "rgba(167,139,250,0.42)",
                      color: "#eee",
                    }}
                  >
                    {pendingAction === "save" ? "保存中..." : "保存"}
                  </button>
                  <button
                    onClick={() => {if (window.confirm("删除这条偏好？")) handleDeleteMemory(item.id);}}
                    disabled={memoryPending !== null}
                    style={{
                      ...inputStyle,
                      width: "auto",
                      padding: "6px 12px",
                      cursor: "pointer",
                      background: "transparent",
                      color: "#f87171",
                    }}
                  >
                    {pendingAction === "delete" ? "删除中..." : "删除"}
                  </button>
                </div>
              </div>
            );
          })
        )}
        {memoryNotice && (
          <div style={{ color: "#a78bfa", fontSize: 12, marginTop: 8 }}>{memoryNotice}</div>
        )}

            </div></>}
            </>}
            {errorMsg && <div className="settings-message error" role="alert">{errorMsg}</div>}
            {notice && <div className="settings-message" role="status">{notice}</div>}
          </div>
        </div>
        <style>{SELECT_CSS}</style>
      </div>
    </div>
  );
}
