-- C37：問答的頒獎畫面
--
-- 最後一題結束之後，現在只會停在「各桌積分」那一頁——那是一張表格，
-- 每一題結束都長一樣。整場遊戲玩完，前幾名值得一個獨立的畫面。
--
-- 資料層要做的只有一件事：多一個階段。前五名本來就查得到
-- （quiz_team_leaderboard／quiz_individual_leaderboard），不必新增任何查詢。
--
-- awards 跟 idle 同一類：它不在時間軸上。
--
--   prep／answer／reveal／scoreboard 是從 started_at 推算出來的，
--   三百支手機各自算，不必為了「現在第幾秒」一直問伺服器。
--   awards 沒有倒數、不會自己跑完，也不該被下一秒的時間推走——
--   主持人要它停多久就停多久。所以它跟 idle 一樣存在欄位裡，
--   由 quiz_phase_at 直接認出來，不看 started_at。
--
-- 這也表示跳到頒獎不會動到 started_at，因此「這一題重播」
-- 與既有的作答判定完全不受影響。
--
-- 此檔可重複執行。

-- ============================================================
-- 欄位的合法值多一個
-- ============================================================

-- 'auto' 一定要留著：start_quiz_question 就是寫這一個值，
-- 意思是「這一段照時間走」。把它從清單裡漏掉的話，
-- 整個問答會在主持人按下「開始第 1 題」的那一刻壞掉。
alter table public.game_sessions
  drop constraint if exists game_sessions_phase_valid;

alter table public.game_sessions
  add constraint game_sessions_phase_valid
  check (phase in ('idle', 'auto', 'prep', 'answer', 'reveal',
                   'scoreboard', 'awards'));

-- ============================================================
-- 階段推算：awards 與 idle 一樣直接認欄位
-- ============================================================

-- 簽名沒變，create or replace 就夠；其他函式都是呼叫它，不必跟著改。
create or replace function public.quiz_phase_at(
  p_stored     text,
  p_elapsed_ms bigint,
  p_prep       int,
  p_answer     int,
  p_reveal     int
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    -- 頒獎：主持人按下去才會進來，也只有主持人能讓它離開
    when p_stored = 'awards' then 'awards'
    -- 主持人按了「回到待機」，或根本還沒出過題
    when p_stored = 'idle' or p_elapsed_ms is null then 'idle'
    when p_elapsed_ms < p_prep * 1000 then 'prep'
    -- 寬限期內畫面仍停在作答，正解要等它過去才准出現
    when p_elapsed_ms < (p_prep + p_answer) * 1000 + public.quiz_answer_grace_ms()
      then 'answer'
    when p_elapsed_ms
       < (p_prep + p_answer + p_reveal) * 1000 + public.quiz_answer_grace_ms()
      then 'reveal'
    else 'scoreboard'
  end;
$$;

revoke execute on function public.quiz_phase_at(text, bigint, int, int, int) from public;
grant execute on function public.quiz_phase_at(text, bigint, int, int, int) to anon, authenticated;

-- ============================================================
-- 主持人跳段：多接一個 awards
-- ============================================================

drop function if exists public.jump_quiz_phase(uuid, text);

create or replace function public.jump_quiz_phase(
  p_session_id uuid,
  p_phase      text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
  v_q       public.quiz_questions;
  v_grace   numeric;
  v_back    numeric;
begin
  if p_phase not in
     ('idle', 'prep', 'answer', 'reveal', 'scoreboard', 'awards') then
    raise exception 'INVALID_PHASE';
  end if;

  select * into v_session from public.game_sessions s
   where s.id = p_session_id
     and exists (select 1 from public.events e
                  where e.id = s.event_id and e.host_id = auth.uid());

  if v_session.id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  -- 收掉整個問答、或停在頒獎：這兩個都不是時間軸上的一段，
  -- 所以只寫欄位、不動 started_at
  if p_phase in ('idle', 'awards') then
    update public.game_sessions set phase = p_phase where id = p_session_id;
    perform realtime.send(
      jsonb_build_object('session_id', p_session_id, 'phase', p_phase),
      'quiz:phase', 'game:' || p_session_id, false);
    return;
  end if;

  select * into v_q from public.quiz_questions q
   where q.id = v_session.current_question_id;

  -- 還沒出題就沒有時間軸可以跳
  if v_q.id is null then
    return;
  end if;

  v_grace := public.quiz_answer_grace_ms() / 1000.0;

  v_back := case p_phase
    when 'prep'   then 0
    when 'answer' then v_q.prep_seconds
    when 'reveal' then v_q.prep_seconds + v_q.answer_seconds + v_grace + 1
    else v_q.prep_seconds + v_q.answer_seconds + v_q.reveal_seconds + v_grace + 1
  end;

  update public.game_sessions
     set phase = 'answer',
         started_at = clock_timestamp() - make_interval(secs => v_back)
   where id = p_session_id;

  perform realtime.send(
    jsonb_build_object('session_id', p_session_id, 'phase', p_phase),
    'quiz:phase', 'game:' || p_session_id, false);
end;
$$;

revoke all on function public.jump_quiz_phase(uuid, text) from public;
grant execute on function public.jump_quiz_phase(uuid, text) to authenticated;

-- ============================================================
-- 舊的直接寫欄位版本也一併放行，免得它變成唯一擋住 awards 的地方
-- ============================================================

create or replace function public.set_quiz_phase(
  p_session_id uuid,
  p_phase      text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_phase not in
     ('idle', 'prep', 'answer', 'reveal', 'scoreboard', 'awards') then
    raise exception 'INVALID_PHASE';
  end if;

  update public.game_sessions s
     set phase = p_phase
   where s.id = p_session_id
     and exists (select 1 from public.events e
                  where e.id = s.event_id and e.host_id = auth.uid());

  if not found then
    raise exception 'NOT_EVENT_HOST';
  end if;

  perform realtime.send(
    jsonb_build_object('session_id', p_session_id, 'phase', p_phase),
    'quiz:phase', 'game:' || p_session_id, false);
end;
$$;

revoke execute on function public.set_quiz_phase(uuid, text) from public;
grant execute on function public.set_quiz_phase(uuid, text) to authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');

-- ============================================================
-- 驗證
-- ============================================================
select
  public.quiz_phase_at('awards', 2000, 5, 20, 6)     as "頒獎不看時間",
  public.quiz_phase_at('awards', null, 5, 20, 6)     as "頒獎不需要題目",
  public.quiz_phase_at('auto', 2000, 5, 20, 6)       as "2 秒：讀題",
  public.quiz_phase_at('auto', 33000, 5, 20, 6)      as "33 秒：排行",
  public.quiz_phase_at('idle', 9000, 5, 20, 6)       as "強制待機";
