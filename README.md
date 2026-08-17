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
    play/[code]/      遊戲玩家入座（掃桌卡）
    stage/[code]/     世界大螢幕
    host/             主持人控制台
    health/           連線診斷（開發用）
  components/
    draw/             Canvas 繪圖工具
    checkin/          電子簽到與簽名板
    quiz/             問答的手機端與大螢幕
    host/             控制台 UI（側邊欄分頁）
    stage/            大螢幕的 React 外殼
  world/
    engine/           PixiJS 渲染核心，不認識任何特定世界
    templates/        各世界模板與註冊表（river、ocean、forest）
    types.ts          WorldTemplate 介面（渲染層契約）
  lib/
    supabase/         client / server
    image/            角色圖片處理（裁邊、縮放、WebP）
supabase/
  migrations/         資料庫 migration
  setup_all.sql       合併後的完整安裝腳本（由 build_setup_all.py 產生）
  setup_quiz.sql      只裝問答
  setup_checkin.sql   只裝電子簽到
```

## 資料庫安裝

`supabase/migrations/` 是真實來源，但 Supabase 的 SQL Editor 一次只跑一份檔案，
因此另外合併出三份可直接貼上執行的腳本：

```bash
python3 supabase/build_setup_all.py   # 新增 migration 後一定要重跑
```

| 腳本 | 什麼時候用 |
| --- | --- |
| `setup_all.sql` | 全新資料庫，或想一次補齊所有東西 |
| `setup_quiz.sql` | 已裝過 setup_all，只要補問答 |
| `setup_checkin.sql` | 已裝過 setup_all，只要補電子簽到 |

三份都可以重複執行，不會刪除既有資料。貼上後務必**全選再按 Run**——
SQL Editor 只執行選取的範圍，游標放在中間按 Run 會只跑一段，
看起來像是「跑了卻沒生效」。腳本最後會列出每個物件是「已建立」還是「缺少」。

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
| M8 | 打磨：待機畫面、中獎者牆、Logo、BGM、森林世界 | 完成 |

## 遊戲模式里程碑

抽獎之外的第二種模式：分隊、手機當控制器、大螢幕呈現遊戲畫面。

| # | 內容 | 狀態 |
| --- | --- | --- |
| G0 | 房間與隊伍、每桌 QR 桌卡、玩家入座 | 完成 |
| G1 | 對時、節拍、雙手安全握持、搖晃划槳偵測、觸感與音效 | 完成 |
| G2 | 遊戲引擎骨架與大螢幕渲染 | 未開始 |
| G3 | 海洋救援：賽道、船、同步率、名次 | 未開始 |
| G4 | 事件系統與終點演出 | 未開始 |
| G5 | 排行榜與賽後數據 | 未開始 |
| G6 | 美術打磨與人數壓力測試 | 未開始 |

## 問答里程碑

主持人自己出題，每桌推派隊長作答，大螢幕與手機各顯示四個符號。

| # | 內容 | 狀態 |
| --- | --- | --- |
| Q0 | 題庫、階段控制、作答與計分 | 完成 |
| Q1 | 題目配圖 | 完成 |
| Q2 | 階段由 started_at 推算，手機與大螢幕不會各說各話 | 完成 |
| Q3 | 隊長代表賽 | 完成 |
| Q4 | 主題可自由更換（河流／海洋），出題介面簡化 | 完成 |

## 報到里程碑

| # | 內容 | 狀態 |
| --- | --- | --- |
| C0 | 電子簽到：名冊、確認資料、簽名、簽名匯入河道 | 完成 |
| C1 | 彩繪與簽名並存、大螢幕顯示方式可切換、簽到表匯出 | 完成 |
| C2 | 大螢幕的主視覺文字、可調流速；控制台改為側邊欄分頁 | 完成 |
| C3 | 河流視覺重做：烘焙輝光、光粒、絲綢水紋；背景圖上傳與 QR 開關 | 完成 |
| C4 | 主視覺原圖固定為底圖，只讓河道範圍內的光流動（遮罩＋流場） | 完成 |
