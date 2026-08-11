/**
 * 主持人選單用的世界模板清單。
 *
 * 刻意不從 world/templates 的註冊表讀：那份註冊表要 import PixiJS 才拿得到，
 * 而後台頁面完全不需要渲染引擎。多載入一個 Pixi 只為了顯示兩行文字，
 * 會讓後台在會場的網路下多等好幾秒。
 *
 * 新增世界時這裡要跟著加一行。忘了加只會少一個選項，不會壞掉。
 */
export const WORLD_TEMPLATE_OPTIONS: readonly {
  readonly key: string;
  readonly name: string;
  readonly hint: string;
}[] = [
  { key: "river", name: "河流（流嚮）", hint: "深藍水面與金色光流，簽名順流匯聚" },
  { key: "ocean", name: "海洋", hint: "藍色海水與泡泡，角色四處游動" },
  { key: "forest", name: "森林", hint: "綠意與光斑" },
];
