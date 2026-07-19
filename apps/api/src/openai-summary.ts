import {
  titleAndTagsJsonSchema,
  type SummaryGenerator,
} from "@zhihu-video/pipeline";
import type { AiSettings } from "@zhihu-video/contracts";

export class AiConfigurationError extends Error {}

export const defaultAiBaseUrl = "https://api.deepseek.com";
export const defaultAiModel = "deepseek-v4-flash";

export interface ResolvedAiConfiguration {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class OpenAiCompatibleSummaryGenerator implements SummaryGenerator {
  private readonly resolve: () => ResolvedAiConfiguration | null;

  constructor(resolve?: () => ResolvedAiConfiguration | null) {
    this.resolve = resolve ?? (() => readAiConfiguration());
  }

  async summarize(input: {
    sourceTitle: string;
    paragraphs: string[];
  }): Promise<unknown> {
    const configuration = this.resolve();
    if (!configuration)
      throw new AiConfigurationError(
        "未配置 AI_API_KEY、AI_BASE_URL 或 AI_MODEL。",
      );
    const response = await fetch(
      `${configuration.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${configuration.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: configuration.model,
          messages: [
            {
              role: "system",
              content:
                "你是中文内容编辑。仅依据原文输出符合 schema 的 JSON：videoTitle 是不超过 22 个字符的短视频标题，tags 是 2 到 5 个内容标签。不得补充原文没有的事实。",
            },
            {
              role: "user",
              content: JSON.stringify({
                sourceTitle: input.sourceTitle,
                paragraphs: input.paragraphs,
                schema: titleAndTagsJsonSchema,
              }),
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
      },
    );
    if (!response.ok)
      throw new Error(`AI 服务请求失败（HTTP ${response.status}）。`);
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI 服务未返回标题与标签内容。");
    return JSON.parse(content) as unknown;
  }
}

export function readAiConfiguration(environment = process.env): ResolvedAiConfiguration | null {
  const apiKey = environment.AI_API_KEY?.trim();
  if (!apiKey) return null;

  return {
    baseUrl:
      environment.AI_BASE_URL?.trim().replace(/\/$/, "") ?? defaultAiBaseUrl,
    apiKey,
    model: environment.AI_MODEL?.trim() || defaultAiModel,
  };
}

/**
 * Resolves the effective AI configuration by merging DB settings (priority)
 * with environment variables and built-in defaults.
 */
export function resolveAiConfiguration(
  dbSettings: AiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedAiConfiguration | null {
  const apiKey =
    dbSettings.apiKey?.trim() || environment.AI_API_KEY?.trim() || null;
  if (!apiKey) return null;
  return {
    baseUrl:
      dbSettings.baseUrl?.trim().replace(/\/$/, "") ||
      environment.AI_BASE_URL?.trim().replace(/\/$/, "") ||
      defaultAiBaseUrl,
    apiKey,
    model:
      dbSettings.model?.trim() ||
      environment.AI_MODEL?.trim() ||
      defaultAiModel,
  };
}
