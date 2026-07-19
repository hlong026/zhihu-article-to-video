import { Brain, Eye, EyeOff, Gauge, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  processingConcurrencyOptions,
  type AiSettingsView,
  type ProcessingSettings,
} from "@zhihu-video/contracts";

import { apiClient } from "../api/client";
import { useToast } from "../components/Toast";

export function SettingsPage() {
  const { toast } = useToast();
  const [aiSettings, setAiSettings] = useState<AiSettingsView | null>(null);
  const [processing, setProcessing] = useState<ProcessingSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // AI form state
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [isSavingAi, setIsSavingAi] = useState(false);

  const loadSettings = useCallback(async () => {
    const [ai, proc] = await Promise.all([
      apiClient.getAiSettings(),
      apiClient.getProcessing(),
    ]);
    setAiSettings(ai);
    setProcessing(proc);
    setApiKey(ai.apiKey ?? "");
    setBaseUrl(ai.baseUrl ?? "");
    setModel(ai.model ?? "");
  }, []);

  useEffect(() => {
    loadSettings()
      .catch((error: unknown) =>
        toast(
          error instanceof Error ? error.message : "读取设置失败。",
          "error",
        ),
      )
      .finally(() => setIsLoading(false));
  }, [loadSettings, toast]);

  async function handleSaveAi() {
    setIsSavingAi(true);
    try {
      const updated = await apiClient.updateAiSettings({
        apiKey: apiKey.trim() || null,
        baseUrl: baseUrl.trim() || null,
        model: model.trim() || null,
      });
      setAiSettings(updated);
      toast("AI 模型设置已保存。", "success");
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "AI 设置保存失败。",
        "error",
      );
    } finally {
      setIsSavingAi(false);
    }
  }

  function handleConcurrencyChange(concurrency: number) {
    apiClient
      .updateProcessing({ concurrency })
      .then((next) => {
        setProcessing(next);
        toast(`并发数已调整为 ${next.concurrency}，对之后启动的批次生效。`, "success");
      })
      .catch((error: unknown) =>
        toast(
          error instanceof Error ? error.message : "并发设置保存失败。",
          "error",
        ),
      );
  }

  if (isLoading) {
    return <div className="page-loading">正在加载设置…</div>;
  }

  return (
    <div className="settings-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">应用配置</p>
          <h1>设置</h1>
          <p className="header-description">
            配置 AI 模型与批量处理参数，保存后立即生效。
          </p>
        </div>
      </header>

      {/* AI Model Settings */}
      <section className="settings-card" aria-labelledby="ai-settings-title">
        <div className="settings-card-head">
          <span className="settings-card-icon">
            <Brain size={20} />
          </span>
          <div>
            <h2 id="ai-settings-title">AI 模型配置</h2>
            <p>
              用于生成视频标题与标签。支持任何 OpenAI 兼容接口（DeepSeek、OpenAI、Moonshot 等）。
            </p>
          </div>
          <span
            className={`settings-status-badge${aiSettings?.configured ? " configured" : ""}`}
          >
            {aiSettings?.configured ? "已配置" : "未配置"}
          </span>
        </div>

        <div className="settings-form">
          <label className="settings-field">
            <span className="settings-label">API Key</span>
            <div className="settings-input-group">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="settings-input-toggle"
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? "隐藏" : "显示"}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <span className="settings-hint">
              留空则使用环境变量 AI_API_KEY
            </span>
          </label>

          <label className="settings-field">
            <span className="settings-label">接口地址（Base URL）</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={aiSettings?.effectiveBaseUrl ?? "https://api.deepseek.com"}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="settings-hint">
              留空使用默认值：{aiSettings?.effectiveBaseUrl ?? "https://api.deepseek.com"}
            </span>
          </label>

          <label className="settings-field">
            <span className="settings-label">模型名称</span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={aiSettings?.effectiveModel ?? "deepseek-v4-flash"}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="settings-hint">
              留空使用默认值：{aiSettings?.effectiveModel ?? "deepseek-v4-flash"}
            </span>
          </label>

          <div className="settings-actions">
            <button
              type="button"
              className="button button-dark"
              onClick={() => void handleSaveAi()}
              disabled={isSavingAi}
            >
              <Save size={16} />
              {isSavingAi ? "保存中…" : "保存 AI 设置"}
            </button>
          </div>
        </div>
      </section>

      {/* Processing Settings */}
      <section className="settings-card" aria-labelledby="processing-settings-title">
        <div className="settings-card-head">
          <span className="settings-card-icon">
            <Gauge size={20} />
          </span>
          <div>
            <h2 id="processing-settings-title">批量处理并发</h2>
            <p>
              知乎内容抓取始终串行限流（防风控）；并发只加快 AI 与图片/视频渲染。
            </p>
          </div>
        </div>

        <div className="settings-form">
          <div className="settings-field">
            <span className="settings-label">并发任务数</span>
            <div className="settings-concurrency-options">
              {processingConcurrencyOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`concurrency-chip${processing?.concurrency === option ? " active" : ""}`}
                  onClick={() => handleConcurrencyChange(option)}
                >
                  {option} 并发
                </button>
              ))}
            </div>
            {processing && processing.concurrency >= 15 ? (
              <span className="settings-hint warning">
                高并发会同时运行多个渲染进程，CPU 与内存占用明显上升；若机器卡顿请调低档位。
              </span>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
