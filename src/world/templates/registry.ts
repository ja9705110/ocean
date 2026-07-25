import type { WorldTemplate, WorldTemplateKey } from "@/world/types";

/**
 * 世界模板註冊表：key → WorldTemplate。
 *
 * 新增世界的流程只有兩步：
 * 1. 新增 templates/{key}.ts 並實作 WorldTemplate
 * 2. 在 templates/index.ts 匯入並呼叫 registerWorldTemplate()
 *
 * 渲染核心不需要任何修改。M3 會註冊第一個模板 ocean。
 */
const registry = new Map<WorldTemplateKey, WorldTemplate>();

/** 活動未指定或指定了未知模板時的預設值 */
export const DEFAULT_WORLD_TEMPLATE_KEY: WorldTemplateKey = "ocean";

export function registerWorldTemplate(template: WorldTemplate): void {
  if (registry.has(template.key)) {
    throw new Error(`世界模板重複註冊：${template.key}`);
  }
  registry.set(template.key, template);
}

/** 依 key 取得模板；key 來自資料庫，因此接受任意字串 */
export function getWorldTemplate(key: string): WorldTemplate | undefined {
  return registry.get(key as WorldTemplateKey);
}

/** 取得模板，找不到時退回預設模板；預設模板也未註冊時才拋出 */
export function resolveWorldTemplate(key: string): WorldTemplate {
  const template =
    registry.get(key as WorldTemplateKey) ??
    registry.get(DEFAULT_WORLD_TEMPLATE_KEY);

  if (!template) {
    throw new Error(
      `找不到世界模板「${key}」，且預設模板「${DEFAULT_WORLD_TEMPLATE_KEY}」尚未註冊。`,
    );
  }

  return template;
}

/** 列出所有已註冊的模板，供主持人端的模板選單使用 */
export function listWorldTemplates(): readonly WorldTemplate[] {
  return [...registry.values()];
}
