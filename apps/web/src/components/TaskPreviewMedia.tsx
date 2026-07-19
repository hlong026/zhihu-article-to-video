import { AlertTriangle, ImageOff, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ArticleTask, ArticleTaskDetail } from "@zhihu-video/contracts";

import { apiClient, isActiveTaskStatus } from "../api/client";
import { StatusBadge, statusLabel } from "./StatusBadge";
import { TaskStepper } from "./TaskStepper";

interface TaskPreviewMediaProps {
  task: ArticleTask;
  detail: ArticleTaskDetail | null;
}

/** Cover image with object-URL lifecycle handled for the desktop bridge. */
function PreviewImage({ task }: { task: ArticleTask }) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setFailed(false);
    apiClient
      .getPreviewImageSource(task.id)
      .then((next) => {
        if (cancelled) {
          if (next?.startsWith("blob:")) URL.revokeObjectURL(next);
          return;
        }
        objectUrl = next?.startsWith("blob:") ? next : null;
        setSource(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [task.id, task.updatedAt]);

  if (failed || !source) {
    return (
      <div className="preview-media-fallback" role="note">
        <ImageOff size={20} />
        <span>封面预览暂不可用，可直接下载成品查看。</span>
      </div>
    );
  }
  return (
    <img
      className="preview-media-image"
      src={source}
      alt={`${task.finalTitle ?? task.inputTitle ?? "任务"} 封面`}
      onError={() => setFailed(true)}
    />
  );
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

interface CompletedPreviewProps {
  task: ArticleTask;
  artifacts: { imageCount: number; videoReady: boolean; durationSeconds: number } | null;
  canStreamVideo: boolean;
}

/** Shows a cover poster with a play button; clicking starts video playback. */
function CompletedPreview({ task, artifacts, canStreamVideo }: CompletedPreviewProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Reset play state when switching tasks
  useEffect(() => {
    setIsPlaying(false);
  }, [task.id, task.updatedAt]);

  // Autoplay once the video element is mounted and has enough data
  useEffect(() => {
    if (!isPlaying) return;
    const video = videoRef.current;
    if (!video) return;
    if (video.readyState >= 3) {
      video.play().catch(() => undefined);
    } else {
      const onCanPlay = () => video.play().catch(() => undefined);
      video.addEventListener("canplay", onCanPlay, { once: true });
      return () => video.removeEventListener("canplay", onCanPlay);
    }
  }, [isPlaying]);

  function handlePlayClick() {
    setIsPlaying(true);
  }

  return (
    <div className="preview-media">
      {isPlaying && canStreamVideo ? (
        <video
          ref={videoRef}
          key={`${task.id}-${task.updatedAt}`}
          className="preview-media-video"
          controls
          autoPlay
          preload="metadata"
          src={apiClient.getDownloadUrl(task.id, "video")}
        />
      ) : canStreamVideo ? (
        <div
          className="preview-media-poster"
          role="button"
          tabIndex={0}
          aria-label="播放视频"
          onClick={handlePlayClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") handlePlayClick();
          }}
        >
          <PreviewImage task={task} />
          <div className="preview-play-overlay">
            <span className="preview-play-button">
              <Play size={26} fill="currentColor" />
            </span>
          </div>
        </div>
      ) : artifacts && artifacts.imageCount > 0 ? (
        <PreviewImage task={task} />
      ) : (
        <div className="preview-media-fallback" role="note">
          <ImageOff size={20} />
          <span>产物已被清理，可重试任务重新生成。</span>
        </div>
      )}
      {artifacts ? (
        <p className="preview-media-meta">
          共 {artifacts.imageCount} 页 · 约{" "}
          {formatDuration(artifacts.durationSeconds)}
          {artifacts.videoReady && !isPlaying ? " · 点击播放预览" : ""}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Real preview surface: the rendered video / cover image for finished tasks,
 * the pipeline stepper for running ones, and the failure context otherwise.
 */
export function TaskPreviewMedia({ task, detail }: TaskPreviewMediaProps) {
  const artifacts = detail?.artifacts ?? null;

  if (isActiveTaskStatus(task.status) || task.status === "pending") {
    return (
      <div className="preview-media preview-media-status">
        <TaskStepper task={task} />
        <p className="preview-media-hint">
          {task.status === "pending"
            ? "任务排队中，启动批次后自动处理。"
            : `正在${statusLabel(task.status)}… ${task.progress}%`}
        </p>
      </div>
    );
  }

  if (task.status === "completed") {
    const canStreamVideo = artifacts?.videoReady;
    return (
      <CompletedPreview
        task={task}
        artifacts={artifacts}
        canStreamVideo={Boolean(canStreamVideo)}
      />
    );
  }

  // failed / needs_review
  return (
    <div className="preview-media preview-media-status">
      <div className="preview-failure" role="alert">
        <AlertTriangle size={16} />
        <div>
          <StatusBadge status={task.status} />
          <p>{task.failureMessage ?? "任务需要人工处理。"}</p>
        </div>
      </div>
      <TaskStepper task={task} />
    </div>
  );
}

/** Chronological attempt/step log shown for failed or reviewed tasks. */
export function AttemptTimeline({ detail }: { detail: ArticleTaskDetail | null }) {
  if (!detail || detail.attempts.length === 0) return null;
  return (
    <ol className="attempt-timeline" aria-label="处理记录">
      {detail.attempts.map((attempt) => (
        <li key={attempt.id}>
          <time dateTime={attempt.createdAt}>
            {new Intl.DateTimeFormat("zh-CN", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(attempt.createdAt))}
          </time>
          <span className="attempt-step">{attempt.step}</span>
          {attempt.message ? (
            <span className="attempt-message">{attempt.message}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
