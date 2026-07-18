import { Music, Pause, Play, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BgmSettingsView } from "@zhihu-video/contracts";

import { apiClient } from "../api/client";

interface BgmSettingsCardProps {
  onNotice: (message: string) => void;
}

export function BgmSettingsCard({ onNotice }: BgmSettingsCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [bgm, setBgm] = useState<BgmSettingsView | null>(null);
  const [volume, setVolume] = useState(0.3);
  const [isBusy, setIsBusy] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  useEffect(() => {
    void apiClient
      .getBgm()
      .then((data) => {
        setBgm(data);
        setVolume(data.volume);
      })
      .catch((error: unknown) =>
        onNotice(error instanceof Error ? error.message : "读取背景音乐设置失败。"),
      );
  }, [onNotice]);

  // Release any pending object URL when the card unmounts.
  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  function stopPreview() {
    const audio = audioRef.current;
    if (audio && !audio.paused) audio.pause();
  }

  function apply(promise: Promise<BgmSettingsView | null>, success: string) {
    // Switching the track mid-preview would keep playing the stale audio.
    stopPreview();
    setIsBusy(true);
    promise
      .then((data) => {
        if (!data) return;
        setBgm(data);
        setVolume(data.volume);
        onNotice(success);
      })
      .catch((error: unknown) =>
        onNotice(error instanceof Error ? error.message : "背景音乐设置失败。"),
      )
      .finally(() => setIsBusy(false));
  }

  async function togglePreview() {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    try {
      const source = await apiClient.getBgmPreviewSource();
      if (!source) {
        onNotice("当前没有可试听的背景音乐。");
        return;
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = source.startsWith("blob:") ? source : null;
      audio.src = source;
      audio.volume = volume;
      await audio.play();
    } catch (error: unknown) {
      onNotice(error instanceof Error ? error.message : "试听失败。");
    }
  }

  function handleUpload(file?: File) {
    if (!window.desktop && !file) return;
    apply(apiClient.uploadBgm(file), "背景音乐已更新，新的成片将带上这段音乐。");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function openUploadDialog() {
    if (window.desktop) {
      handleUpload();
      return;
    }
    fileInputRef.current?.click();
  }

  if (!bgm) return null;

  return (
    <section className="bgm-card" aria-labelledby="bgm-card-title">
      <div className="bgm-head">
        <span className="bgm-icon">
          <Music size={20} />
        </span>
        <div>
          <p className="eyebrow" id="bgm-card-title">
            背景音乐
          </p>
          <strong>{bgm.enabled && bgm.fileName ? bgm.fileName : "未启用"}</strong>
          <span>为之后渲染的所有视频统一添加背景音乐。</span>
        </div>
        <label className="bgm-switch">
          <input
            type="checkbox"
            checked={bgm.enabled}
            disabled={isBusy || !bgm.hasAudio}
            onChange={(event) =>
              apply(
                apiClient.updateBgm({ enabled: event.target.checked }),
                event.target.checked ? "背景音乐已开启。" : "背景音乐已关闭。",
              )
            }
          />
          <span>{bgm.enabled ? "已开启" : "已关闭"}</span>
        </label>
      </div>

      <div className="bgm-controls">
        <label className="bgm-field">
          <span>内置预设</span>
          <select
            value={bgm.source === "preset" ? (bgm.presetId ?? "") : ""}
            disabled={isBusy}
            onChange={(event) => {
              if (!event.target.value) return;
              apply(
                apiClient.updateBgm({ presetId: event.target.value }),
                "已选择预设背景音乐。",
              );
            }}
          >
            <option value="">选择一段预设…</option>
            {bgm.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>

        <div className="bgm-field">
          <span>本地音频</span>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".mp3,.m4a,.wav,audio/*"
            onChange={(event) => handleUpload(event.target.files?.[0])}
          />
          <button
            type="button"
            className="button"
            onClick={openUploadDialog}
            disabled={isBusy}
          >
            <Upload size={15} />
            上传音频文件
          </button>
        </div>

        <label className="bgm-field bgm-volume">
          <span>音量 {Math.round(volume * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            disabled={isBusy || !bgm.hasAudio}
            onChange={(event) => setVolume(Number(event.target.value))}
            onPointerUp={() =>
              apply(apiClient.updateBgm({ volume }), "背景音乐音量已保存。")
            }
            onKeyUp={() =>
              apply(apiClient.updateBgm({ volume }), "背景音乐音量已保存。")
            }
          />
        </label>
      </div>

      {bgm.hasAudio ? (
        <div className="bgm-footer">
          <button
            type="button"
            className="text-button bgm-preview"
            onClick={() => void togglePreview()}
          >
            {isPreviewing ? <Pause size={14} /> : <Play size={14} />}
            {isPreviewing ? "停止试听" : "试听"}
          </button>
          <button
            type="button"
            className="text-button bgm-clear"
            onClick={() =>
              apply(apiClient.clearBgm(), "已移除背景音乐，成片将不含音乐。")
            }
            disabled={isBusy}
          >
            <Trash2 size={14} />
            移除背景音乐
          </button>
        </div>
      ) : (
        <p className="bgm-hint">选择一段预设，或上传 mp3 / m4a / wav 文件。</p>
      )}

      <audio
        ref={audioRef}
        className="visually-hidden"
        onPlay={() => setIsPreviewing(true)}
        onPause={() => setIsPreviewing(false)}
        onEnded={() => setIsPreviewing(false)}
      />
    </section>
  );
}
