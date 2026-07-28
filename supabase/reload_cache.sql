-- 重載 PostgREST 的結構快取
--
-- 什麼時候用：前端出現「在模式快取中找不到函式 public.xxx」。
--
-- 為什麼會發生：PostgREST 把資料庫的函式與資料表結構快取在記憶體裡。
-- 新建或修改過的函式，要等它收到通知（或快取自然過期）才看得見。
-- setup_all.sql 最後已經會送這個通知，但有兩種情況會漏掉：
--   1. 在 SQL Editor 裡只選取了一部分執行（游標所在的那一段），
--      最後那幾行根本沒跑到。按 Run 之前先 Ctrl/Cmd + A 全選。
--   2. 通知送出的當下 PostgREST 剛好在重啟。
--
-- 這一份只送通知，不改動任何資料，可以放心重複執行。

notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');

-- ============================================================
-- 診斷：三種原因分得出來
-- ============================================================
-- 已建立   → 函式在、權限也對，那就純粹是快取，上面那兩行已經處理了
-- 缺少     → 腳本根本沒跑完（多半是 SQL Editor 只執行了游標所在那一段）
-- 沒有權限 → 函式建立了但 grant 沒生效；PostgREST 看不到的函式，
--            回報的訊息同樣是「找不到」，所以這一欄一定要看
with expected(fn, who) as (
  values
    -- 問答
    ('upsert_quiz_question', 'authenticated'),
    ('delete_quiz_question', 'authenticated'),
    ('move_quiz_question',   'authenticated'),
    ('list_quiz_questions',  'authenticated'),
    ('start_quiz_question',  'authenticated'),
    ('set_quiz_phase',       'authenticated'),
    ('end_answer_early',     'authenticated'),
    ('submit_quiz_answer',   'anon'),
    ('get_quiz_play_state',  'anon'),
    ('get_quiz_stage_state', 'anon'),
    ('quiz_phase_at',        'anon'),
    ('quiz_answer_grace_ms', 'anon'),
    ('quiz_individual_leaderboard', 'anon'),
    ('quiz_team_leaderboard',       'anon'),
    -- 遊戲房間
    ('create_game_session',  'authenticated'),
    ('list_event_game_sessions', 'authenticated'),
    ('join_game',            'anon'),
    ('list_session_teams',   'anon'),
    ('list_team_players',    'anon'),
    ('server_now',           'anon'),
    ('get_play_state',       'anon'),
    ('start_round',          'authenticated'),
    ('end_round',            'authenticated'),
    -- 抽獎
    ('create_event',         'authenticated'),
    ('list_my_events',       'authenticated'),
    ('get_event_snapshot',   'anon'),
    ('draw_winner',          'authenticated'),
    ('list_event_prizes',    'anon'),
    ('list_event_draws',     'anon')
)
select
  e.fn as 函式名稱,
  e.who as 呼叫身分,
  case
    when p.oid is null then '缺少'
    when not has_function_privilege(e.who, p.oid, 'execute') then '沒有權限'
    else '已建立'
  end as 狀態
from expected e
left join pg_proc p
       on p.proname = e.fn and p.pronamespace = 'public'::regnamespace
order by 狀態, e.fn;
