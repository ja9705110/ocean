-- C22：主持人按下去要真的跳過去
--
-- 這是一個我上一版做壞的東西，先講清楚它為什麼壞：
--
-- 大螢幕與手機看到的階段不是讀 game_sessions.phase 那一欄，而是
-- quiz_phase_at() 依 started_at 推算出來的。那個設計是對的——
-- 三百支手機不必為了「現在第幾秒」一直問伺服器，各自從同一個
-- started_at 算就好。
--
-- 但 quiz_phase_at 只認 'idle' 這一個存下來的值，其他一律看時間。
-- 所以 set_quiz_phase 寫進去的 'reveal'／'scoreboard' 沒有人在讀，
-- 主持人按了「現在公布答案」，畫面完全不動。
--
-- 正確的做法跟 end_answer_early 一樣：不是去寫一個沒人看的欄位，
-- 而是把 started_at 往回挪，讓時間軸本身落在要的那一段。
--
-- 各段的起點（grace 是作答截止後的寬限期，正解要等它過去才准出現）：
--
--   prep        now
--   answer      now - prep
--   reveal      now - prep - answer - grace
--   scoreboard  now - prep - answer - reveal - grace
--
-- reveal 與 scoreboard 多退一秒，避開剛好卡在邊界上的來回跳動。
--
-- idle 仍然走存下來的欄位——那是「整個收掉」，不屬於時間軸。
--
-- 此檔可重複執行。

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
  if p_phase not in ('idle', 'prep', 'answer', 'reveal', 'scoreboard') then
    raise exception 'INVALID_PHASE';
  end if;

  select * into v_session from public.game_sessions s
   where s.id = p_session_id
     and exists (select 1 from public.events e
                  where e.id = s.event_id and e.host_id = auth.uid());

  if v_session.id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  -- 收掉整個問答：這個不是時間軸上的一段
  if p_phase = 'idle' then
    update public.game_sessions set phase = 'idle' where id = p_session_id;
    perform realtime.send(
      jsonb_build_object('session_id', p_session_id, 'phase', 'idle'),
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
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
