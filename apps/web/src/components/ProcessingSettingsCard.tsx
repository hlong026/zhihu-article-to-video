import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import {
  processingConcurrencyOptions,
  type ProcessingSettings,
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

  useEffect(() => {
    void apiClient
      .getProcessing()
      .then(setSettings)
      .catch((error: unknown) =>
        onNotice(
          error instanceof Error ? error.message : "读取并发设置失败。",
        ),
      );
  }, [onNotice]);

  function handleChange(concurrency: number) {
    setIsBusy(true);
    apiClient
      .updateProcessing({ concurrency })
      .then((next) => {
        setSettings(next);
        onNotice(
          `并发数已调整为 ${next.concurrency}，对之后启动的批次生效。`,
        );
      })
      .catch((error: unknown) =>
        onNotice(error instanceof Error ? error.message : "并发设置保存失败。"),
      )
      .finally(() => setIsBusy(false));
  }

  if (!settings) return null;

  return (
    <section className="bgm-card processing-card" aria-labelledby="processing-card-title">
      <div className="bgm-head">
        <span className="bgm-icon">
          <Gauge size={20} />
        </span>
        <div>
          <p className="eyebrow" id="processing-card-title">
            批量处理并发
          </p>
          <strong>{settings.concurrency} 个任务并行</strong>
          <span>
            知乎内容抓取始终串行限流（防风控）；并发只加快 AI 与图片/视频渲染。
          </span>
        </div>
        <label className="processing-select">
          <span className="visually-hidden">并发任务数</span>
          <select
            value={settings.concurrency}
            disabled={isBusy}
            onChange={(event) => handleChange(Number(event.target.value))}
          >
            {processingConcurrencyOptions.map((option) => (
              <option key={option} value={option}>
                {option} 并发
              </option>
            ))}
          </select>
        </label>
      </div>
      {settings.concurrency >= 15 ? (
        <p className="processing-warning" role="note">
          高并发会同时运行多个渲染进程，CPU 与内存占用明显上升；若机器卡顿请调低档位。
        </p>
      ) : null}
    </section>
  );
}
