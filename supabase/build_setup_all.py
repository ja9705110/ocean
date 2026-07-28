"""把 supabase/migrations 底下的所有檔案合併成一支可重複執行的安裝腳本。

用法（在專案根目錄）：

    python3 supabase/build_setup_all.py

新增 migration 之後一定要重跑，否則 setup_all.sql 會落後。
"""

import glob
import re

FILES = sorted(glob.glob("supabase/migrations/*.sql"))

RELOAD_MARKER = "-- ============================================================\n-- 讓 PostgREST 立即看見上面的變更"
VERIFY_MARKER = "-- ============================================================\n-- 驗證"


def strip_tail(text: str) -> str:
    """移除各檔自帶的快取重載與驗證區塊，改由合併腳本統一在最後處理。"""
    for marker in (RELOAD_MARKER, VERIFY_MARKER):
        idx = text.find(marker)
        if idx >= 0:
            text = text[:idx]
    # m7b / m8 結尾自帶的 select 驗證也一併去掉
    text = re.sub(r"\nnotify pgrst, 'reload schema';\s*", "\n", text)
    text = re.sub(r"\nselect id, file_size_limit[^;]*;\s*$", "\n", text)
    text = re.sub(r"\nselect id, public, file_size_limit[^;]*;\s*$", "\n", text)
    return text.rstrip() + "\n"


def make_idempotent(text: str) -> str:
    """M1 的建表語句原本假設是空資料庫，補上可重複執行所需的防護。"""
    text = re.sub(r"\bcreate table public\.", "create table if not exists public.", text)
    text = re.sub(r"\bcreate index (\w+)", r"create index if not exists \1", text)
    text = re.sub(
        r"\bcreate unique index (\w+)", r"create unique index if not exists \1", text
    )

    # 觸發器與政策沒有 if not exists，改為先 drop
    def guard_trigger(match: "re.Match[str]") -> str:
        name, table = match.group(1), match.group(2)
        return f"drop trigger if exists {name} on {table};\ncreate trigger {name}\n  after"

    text = re.sub(
        r"create trigger (\w+)\n  after insert or update of \w+ or delete on ([\w.]+)",
        lambda m: guard_trigger(m) + f" insert or update of is_visible or delete on {m.group(2)}",
        text,
    )

    def guard_policy(match: "re.Match[str]") -> str:
        name, table = match.group(1), match.group(2)
        return f"drop policy if exists {name} on {table};\ncreate policy {name} on {table}"

    text = re.sub(r"create policy (\w+) on ([\w.]+)", guard_policy, text)
    return text


HEADER = """-- ============================================================
-- Interactive Event Platform：一次安裝全部資料庫結構
-- ============================================================
--
-- 這一份包含了目前為止所有的資料表、函式、權限政策與儲存設定。
-- 可以重複執行，不會刪除任何既有資料，也不會因為「已存在」而中斷。
--
-- 使用方式：
--   1. Supabase → SQL Editor → 開新查詢
--   2. 整份貼上，按 Ctrl/Cmd + A 全選
--   3. 按 Run
--   4. 看最下方的驗證結果，全部都要是「已建立」
--
-- 為什麼要全選：SQL Editor 在腳本很長時，若只把游標放在某一段，
-- 按 Run 可能只執行游標所在的那一段，造成「跑了卻沒生效」。
--
-- ============================================================

"""

FOOTER = """

-- ============================================================
-- 重載 PostgREST 結構快取
-- ============================================================
-- 沒有這一步，新函式要等快取自然過期才會生效，
-- 前端在那之前一律收到「找不到函式 ...（schema cache）」。
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');

-- ============================================================
-- 驗證一：資料表
-- ============================================================
with expected(obj) as (
  values ('events'), ('participants'), ('draws'), ('prizes'),
         ('game_sessions'), ('teams'), ('game_players'), ('team_results')
)
select
  e.obj as 資料表,
  case when c.oid is null then '缺少' else '已建立' end as 狀態
from expected e
left join pg_class c
       on c.relname = e.obj
      and c.relnamespace = 'public'::regnamespace
      and c.relkind = 'r'
order by 狀態, e.obj;

-- ============================================================
-- 驗證二：函式（全部都必須是「已建立」）
-- ============================================================
with expected(fn) as (
  values
    -- 參與者與世界
    ('get_my_participant'), ('get_stage_participants'),
    ('sync_participant_count'), ('broadcast_participant_change'),
    -- 活動與主持人
    ('generate_event_code'), ('create_event'), ('claim_event'),
    ('list_my_events'), ('list_event_participants'), ('get_event_snapshot'),
    -- 抽獎
    ('list_event_prizes'), ('list_event_draws'),
    ('draw_winner'), ('void_draw'), ('replay_draw'),
    -- 遊戲
    ('generate_team_code'), ('create_game_session'), ('join_game'),
    ('list_session_teams'), ('list_team_players'),
    ('list_event_game_sessions'), ('sync_team_player_count'),
    -- 節拍與對時
    ('server_now'), ('start_round'), ('end_round'), ('get_play_state'),
    -- 問答
    ('upsert_quiz_question'), ('delete_quiz_question'), ('move_quiz_question'),
    ('list_quiz_questions'), ('start_quiz_question'), ('set_quiz_phase'),
    ('submit_quiz_answer'), ('get_quiz_play_state'), ('get_quiz_stage_state'),
    ('quiz_individual_leaderboard'), ('quiz_team_leaderboard')
)
select
  e.fn as 函式名稱,
  case when p.oid is null then '缺少' else '已建立' end as 狀態
from expected e
left join pg_proc p
       on p.proname = e.fn and p.pronamespace = 'public'::regnamespace
order by 狀態, e.fn;

-- ============================================================
-- 驗證三：儲存空間
-- ============================================================
select
  id as bucket,
  case when public then '公開' else '私有' end as 存取,
  file_size_limit as 單檔上限
from storage.buckets
where id in ('characters', 'assets')
order by id;

-- ============================================================
-- 驗證四：後續新增的欄位
-- ============================================================
with expected(tbl, col) as (
  values ('teams', 'creature_key'), ('game_sessions', 'started_at'),
         ('game_sessions', 'current_question_id'), ('game_sessions', 'phase')
)
select
  e.tbl || '.' || e.col as 欄位,
  case when c.column_name is null then '缺少' else '已建立' end as 狀態
from expected e
left join information_schema.columns c
       on c.table_schema = 'public'
      and c.table_name = e.tbl
      and c.column_name = e.col
order by 狀態, 欄位;

-- ============================================================
-- 驗證五：示範活動
-- ============================================================
select code as 活動代碼, name as 名稱, status as 狀態,
       participant_count as 參與人數
  from public.events
 where code = 'DEMO01';
"""

parts = [HEADER]

for path in FILES:
    raw = open(path).read()
    body = strip_tail(raw)
    if "m1_init" in path or "m1_seed" in path:
        body = make_idempotent(body)
    title = path.split("/")[-1].replace(".sql", "")
    parts.append(f"\n\n-- ############################################################\n")
    parts.append(f"-- 來源：{title}\n")
    parts.append(f"-- ############################################################\n\n")
    parts.append(body)

parts.append(FOOTER)

out = "".join(parts)
open("supabase/setup_all.sql", "w").write(out)
print("written, lines:", out.count("\n"))
