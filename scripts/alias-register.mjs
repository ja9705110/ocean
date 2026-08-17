/** 掛上 @/ 路徑別名的解析（見 alias-hook.mjs） */
import { register } from "node:module";

register("./alias-hook.mjs", import.meta.url);
