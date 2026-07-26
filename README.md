# Interactive World Draw

大型活動的互動平台。參與者用手機畫出代表自己的角色，角色即時游進大螢幕上的共創世界，
最後以沉浸式動畫從這個世界中選出中獎者。

單場規模約 350 人同時使用，參與者不需安裝任何 App。

## 技術棧

| 層 | 技術 |
| --- | --- |
| 前端框架 | Next.js 16（App Router） |
| 語言 | TypeScript（strict） |
| 樣式 | Tailwind CSS 4 |
| 渲染引擎 | PixiJS 8 |
| 動畫 | GSAP 3 |
| 後端 / DB / Auth / Storage | Supabase |
| 即時同步 | Supabase Realtime（Broadcast + Postgres Changes） |
| 部署 | Vercel |

## 開始開發

```bash
npm install
cp .env.local.example .env.local   # 填入 Supabase 專案的 URL 與 anon key
npm run dev
```

開啟 <http://localhost:3000> 會看到入口索引，<http://localhost:3000/health> 可確認
Supabase 連線是否正常。未設定環境變數時 `/health` 會列出缺少哪些變數，不會直接崩潰。

### 指令

| 指令 | 說明 |
| --- | --- |
| `npm run dev` | 開發伺服器 |
| `npm run build` | 正式建置 |
| `npm run start` | 啟動已建置的正式版 |
| `npm run lint` | ESLint |
| `npm run typecheck` | 產生路由型別後執行 tsc |

## 環境變數

| 變數 | 用途 | 需要的階段 |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 專案位址 | 全部 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 匿名存取金鑰 | 全部 |
| `SUPABASE_SERVICE_ROLE_KEY` | 伺服器端專用，尚未使用 | M6 |

`NEXT_PUBLIC_` 開頭的變數會在建置階段內嵌進前端 bundle，屬於公開資訊，
安全性由資料庫的 RLS 政策負責。在 Vercel 修改這類變數後必須重新部署才會生效。

`SUPABASE_SERVICE_ROLE_KEY` 可繞過所有 RLS，只能存在於伺服器端環境變數，
不可加上 `NEXT_PUBLIC_` 前綴，也不可寫入版控。

## 部署到 Vercel

1. 在 Vercel 匯入此 GitHub repo，framework 會自動辨識為 Next.js
2. 在 Project Settings → Environment Variables 加入上表的兩個 `NEXT_PUBLIC_` 變數
3. 部署後開啟 `/health` 確認連線

## 目錄結構

```
src/
  app/
    join/[code]/      參與者端（手機）
    stage/[code]/     世界大螢幕
    host/             主持人控制台
    health/           連線診斷（開發用）
  components/
    draw/             Canvas 繪圖工具
    host/             控制台 UI
    stage/            大螢幕的 React 外殼
  world/
    engine/           PixiJS 渲染核心，不認識任何特定世界
    templates/        各世界模板與註冊表
    types.ts          WorldTemplate 介面（渲染層契約）
  lib/
    supabase/         client / server
    image/            角色圖片處理（裁邊、縮放、WebP）
supabase/
  migrations/         資料庫 migration
```

## 開發約定

- 註解與 commit message 使用繁體中文，變數與函式名稱使用英文
- TypeScript 嚴格模式，禁用 `any`（ESLint 會擋）
- 角色圖片一律存 Supabase Storage，資料庫只存路徑；圖片位元不進資料庫欄位，也不進 Realtime payload
- 抽獎結果由資料庫的 RPC 決定，前端只負責播動畫
- 世界模板必須可插拔：新增世界只新增 `world/templates/*.ts`，不修改 `world/engine/`

## 壓力測試

大螢幕網址加上 `?stress=N` 即以本機生成的 N 隻假角色取代真實資料，
不連線後端，左下角顯示即時效能數據：

```
/stage/DEMO01?stress=350
```

用於在實際投影用的筆電上驗收 60fps。上限 1000 隻。

## 里程碑

| # | 內容 | 狀態 |
| --- | --- | --- |
| M0 | 專案初始化、目錄骨架、Supabase client、Vercel 可部署 | 完成 |
| M1 | 資料庫 migration、RLS、種子活動 | 完成 |
| M2 | 參與者端：繪圖、圖片處理、上傳 | 完成 |
| M3 | 大螢幕 v1：PixiJS、ocean 世界、靜態排版 | 完成 |
| M4 | Realtime：即時進場、佇列節流、斷線對帳 | 完成 |
| M5 | 佈局引擎：分帶、避讓、迴繞、350 隻壓力測試 | 完成 |
| M6 | 主持人端：建立活動、QR Code、參與者管理 | 完成 |
| M7 | 抽獎：獎項設定、RPC、broadcast、聚集與揭曉動畫 | 完成 |
| M8 | 打磨：BGM、待機畫面、中獎者牆、其餘世界模板 | 未開始 |
