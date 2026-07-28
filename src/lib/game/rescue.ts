/**
 * 海洋救援的場次設定（G1b）。
 *
 * 設定存在 game_sessions.config，由主持人在後台決定，手機只負責照做。
 * 不讓玩家各自調靈敏度：同一場裡每個人的門檻不一樣，
 * 隊伍之間的划速就不能互相比較，名次也就沒有意義了。
 *
 * config 是 jsonb，內容沒有型別保證。任何一個欄位壞掉都退回預設值——
 * 絕不能因為設定髒了就讓現場開不了場。
 */

import type { Sensitivity } from "@/lib/game/motion";

export interface RescueConfig {
  /** 晃動偵測的門檻，全場統一 */
  readonly sensitivity: Sensitivity;
  /** 一回合多久 */
  readonly durationMs: number;
}

export const DEFAULT_RESCUE_CONFIG: RescueConfig = {
  sensitivity: "medium",
  durationMs: 45000,
};

/** 回合長度的可選值。太短玩不過癮，太長會累。 */
export const DURATION_OPTIONS = [30000, 45000, 60000, 90000] as const;

function isSensitivity(value: unknown): value is Sensitivity {
  return value === "low" || value === "medium" || value === "high";
}

export function parseRescueConfig(
  config: Record<string, unknown> | null | undefined,
): RescueConfig {
  const source = config ?? {};
  const duration = Number(source.durationMs);

  return {
    sensitivity: isSensitivity(source.sensitivity)
      ? source.sensitivity
      : DEFAULT_RESCUE_CONFIG.sensitivity,
    durationMs: Number.isFinite(duration)
      ? Math.min(Math.max(duration, 10000), 300000)
      : DEFAULT_RESCUE_CONFIG.durationMs,
  };
}

/** 把設定寫回 jsonb 的形狀 */
export function toConfigPatch(
  config: RescueConfig,
): Record<string, unknown> {
  return {
    sensitivity: config.sensitivity,
    durationMs: config.durationMs,
  };
}
