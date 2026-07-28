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
-- 順便確認函式到底在不在資料庫裡
-- ============================================================
-- 如果下面顯示「缺少」，那就不是快取問題，是 setup_all.sql 沒跑完，
-- 請回去重跑一次（記得全選）。
with expected(fn) as (
  values
    -- 問答
    ('upsert_quiz_question'), ('delete_quiz_question'), ('move_quiz_question'),
    ('list_quiz_questions'), ('start_quiz_question'), ('set_quiz_phase'),
    ('end_answer_early'), ('submit_quiz_answer'),
    ('get_quiz_play_state'), ('get_quiz_stage_state'),
    ('quiz_phase_at'), ('quiz_answer_grace_ms'),
    ('quiz_individual_leaderboard'), ('quiz_team_leaderboard'),
    -- 遊戲房間
    ('create_game_session'), ('join_game'), ('list_session_teams'),
    ('list_team_players'), ('list_event_game_sessions'),
    ('server_now'), ('start_round'), ('end_round'), ('get_play_state'),
    -- 抽獎
    ('create_event'), ('list_my_events'), ('get_event_snapshot'),
    ('draw_winner'), ('list_event_prizes'), ('list_event_draws')
)
select
  e.fn as 函式名稱,
  case when p.oid is null then '缺少' else '已建立' end as 狀態
from expected e
left join pg_proc p
       on p.proname = e.fn and p.pronamespace = 'public'::regnamespace
order by 狀態, e.fn;
