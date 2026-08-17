import { registerWorldTemplate } from "./registry";
import { oceanTemplate } from "./ocean";
import { riverTemplate } from "./river";
import { imageRiverTemplate } from "./imageRiver";
import { forestTemplate } from "./forest";

/**
 * 模板總註冊點。新增世界：新增 templates/{key}.ts 後在這裡註冊一行，
 * 渲染核心（engine/）不需任何修改。
 */

let registered = false;

export function registerAllTemplates(): void {
  if (registered) {
    return;
  }
  registered = true;

  registerWorldTemplate(oceanTemplate);
  registerWorldTemplate(riverTemplate);
  registerWorldTemplate(imageRiverTemplate);
  registerWorldTemplate(forestTemplate);
}

export { resolveWorldTemplate } from "./registry";
