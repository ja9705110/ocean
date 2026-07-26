import { registerWorldTemplate } from "./registry";
import { oceanTemplate } from "./ocean";

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
}

export { resolveWorldTemplate } from "./registry";
