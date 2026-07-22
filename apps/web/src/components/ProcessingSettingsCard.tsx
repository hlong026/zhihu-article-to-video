import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import {
  bodyPageDurationOptions,
  coverPageDurationOptions,
  processingConcurrencyOptions,
  scrollSpeedDefault,
  scrollSpeedMax,
  scrollSpeedMin,
  type ProcessingSettings,
  type VideoMode,
} from "@zhihu-video/contracts";

import { apiClient } from "../api/client";

interface ProcessingSettingsCardProps {
  onNotice: (message: string) => void;
}

export function ProcessingSettingsCard({
  onNotice,
}: ProcessingSettingsCardProps) {
  const [settings, setSettings] = useState<ProcessingSettings | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [localScrollSpeed, setLocalScrollSpeed] = useState<number | null>(null);

  useEffect(() => {
    void apiClient
      .getProcessing()
      .then((next) => {
        setSettings(next);
        setLocalScrollSpeed(next.scrollSpeed);
      })
      .catch((error: unknown) =>
        onNotice(
          error instanceof Error ? error.message : "读取处理设置失败。",
        ),
      );
  }, [onNotice]);

  function savePatch(
    patch: Partial<ProcessingSettings>,
    successMessage: string,
  ) {
    setIsBusy(true);
    apiClient
      .updateProcessing(patch)
      .then((next) => {
        setSettings(next);
        onNotice(successMessage);
      })
      .catch((error: unknown) =>
        onNotice(error instanceof Error ? error.message : "处理设置保存失败。"),
      )
      .finally(() => setIsBusy(false));
  }

  if (!settings) return null;
  const isScrollMode = settings.videoMode === "scroll";

  return (
    <section
      className="bgm-card processing-card"
      aria-labelledby="processing-card-title"
    >
      <div className="bgm-head">
        <span className="bgm-icon">
          <Gauge size={20} />
        </span>
        <div>
          <p className="eyebrow" id="processing-card-title">
            批量处理设置
          </p>
          <strong>并发 · 页时长 · 视频模式 · 输出范围</strong>
          <span>对之后启动或重试的任务生效；知乎抓取始终串行限流。</span>
        </div>
      </div>

      <div className="processing-controls">
        <label className="processing-field">
          <span className="processing-field-label">并发任务数</span>
          <select
            value={settings.concurrency}
            disabled={isBusy}
            onChange={(event) =>
              savePatch(
                { concurrency: Number(event.target.value) },
                `并发数已调整为 ${event.target.value}。`,
              )
            }
          >
            {processingConcurrencyOptions.map((option) => (
              <option key={option} value={option}>
                {option} 并发
              </option>
            ))}
          </select>
        </label>

        <label className="processing-field">
          <span className="processing-field-label">封面页停留时长</span>
          <select
            value={settings.coverPageDurationSeconds}
            disabled={isBusy || isScrollMode}
            onChange={(event) => {
              const value = Number(event.target.value);
              savePatch(
                { coverPageDurationSeconds: value },
                `封面页停留时长已调整为 ${value} 秒。`,
              );
            }}
          >
            {coverPageDurationOptions.map((option) => (
              <option key={option} value={option}>
                {option} 秒
              </option>
            ))}
          </select>
          {isScrollMode ? (
            <span className="processing-toggle-hint">上下滚动模式下由滚动速度决定时长</span>
          ) : null}
        </label>

        <label className="processing-field">
          <span className="processing-field-label">正文页停留时长</span>
          <select
            value={settings.bodyPageDurationSeconds}
            disabled={isBusy || isScrollMode}
            onChange={(event) => {
              const value = Number(event.target.value);
              savePatch(
                { bodyPageDurationSeconds: value },
                `正文页停留时长已调整为 ${value} 秒。`,
              );
            }}
          >
            {bodyPageDurationOptions.map((option) => (
              <option key={option} value={option}>
                {option} 秒 / 页
              </option>
            ))}
          </select>
          {isScrollMode ? (
            <span className="processing-toggle-hint">上下滚动模式下由滚动速度决定时长</span>
          ) : null}
        </label>

        <div className="processing-field">
          <span className="processing-field-label">视频模式</span>
          <div className="processing-mode-group">
            {(["slide", "scroll"] as const satisfies VideoMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`processing-mode-chip${settings.videoMode === mode ? " active" : ""}`}
                disabled={isBusy}
                onClick={() =>
                  savePatch(
                    { videoMode: mode },
                    mode === "slide"
                      ? "已切换为左右滑动模式。"
                      : "已切换为上下滚动模式。",
                  )
                }
              >
                {mode === "slide" ? "左右滑动" : "上下滚动"}
              </button>
            ))}
          </div>
        </div>

        {settings.videoMode === "scroll" ? (
          <label className="processing-field">
            <span className="processing-field-label">
              滚动速度（{localScrollSpeed ?? settings.scrollSpeed}）
            </span>
            <input
              type="range"
              min={scrollSpeedMin}
              max={scrollSpeedMax}
              step={1}
              value={localScrollSpeed ?? settings.scrollSpeed}
              disabled={isBusy}
              onChange={(event) => setLocalScrollSpeed(Number(event.target.value))}
              onPointerUp={() => {
                if (localScrollSpeed !== null && localScrollSpeed !== settings.scrollSpeed) {
                  savePatch(
                    { scrollSpeed: localScrollSpeed },
                    `滚动速度已调整为 ${localScrollSpeed}。`,
                  );
                }
              }}
              onKeyUp={() => {
                if (localScrollSpeed !== null && localScrollSpeed !== settings.scrollSpeed) {
                  savePatch(
                    { scrollSpeed: localScrollSpeed },
                    `滚动速度已调整为 ${localScrollSpeed}。`,
                  );
                }
              }}
            />
            <span className="processing-toggle-hint">
              1（慢）~ 5（快），默认 {scrollSpeedDefault}
            </span>
          </label>
        ) : null}

        <div className="processing-field processing-toggle-field">
          <span className="processing-field-label">全文输出</span>
          <button
            type="button"
            role="switch"
            aria-checked={settings.fullContentOutput}
            className={`processing-toggle${settings.fullContentOutput ? " is-on" : ""}`}
            disabled={isBusy}
            onClick={() =>
              savePatch(
                { fullContentOutput: !settings.fullContentOutput },
                settings.fullContentOutput
                  ? "已关闭全文输出，超长文章将截取前 10 页。"
                  : "已开启全文输出，正文将完整呈现（不再截取前 10 页）。",
              )
            }
          >
            <i className="processing-toggle-knob" />
          </button>
          <span className="processing-toggle-hint">
            {settings.fullContentOutput
              ? "正文不限页数，封面 + 全部正文"
              : "正文最多 10 页，超出部分以省略号截断"}
          </span>
        </div>
      </div>

      {settings.concurrency >= 15 ? (
        <p className="processing-warning" role="note">
          高并发会同时运行多个渲染进程，CPU 与内存占用明显上升；若机器卡顿请调低档位。
        </p>
      ) : null}
    </section>
  );
}
