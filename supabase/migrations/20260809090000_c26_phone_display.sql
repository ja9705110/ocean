-- C26：主持人決定手機上看得到什麼
--
-- 題目、選項、聊天室三樣，各自能開能關。存在 game_sessions.config 裡，
-- 跟 mode、theme 同一個地方——那是「這場怎麼玩」的設定，不是資料。
--
-- 三個都預設為開以外的既有行為：
--
--   showPrompt   預設關。題目只在大螢幕（C23 就是這樣改的）。
--                想讓看不清楚大螢幕的人也讀得到題目時再打開。
--   showOptions  預設開。關掉之後手機上沒有任何按鈕，
--                整場就只剩下大螢幕與討論。
--   showChat     預設開。
--
-- 為什麼要放進 get_quiz_play_state 而不是讓手機另外查一次設定：
--
--   主持人可能在活動中途才關掉聊天室（「現在專心答題」）。手機本來就
--   一直在拉這支狀態，順手帶回來就是即時生效；另外查一次設定，
--   等於 280 支手機每隔幾秒多打一次伺服器——那正是上一輪剛省下來的。
--
-- 題目與選項在關掉時直接不送，不是送了再讓前端藏起來。前端藏的東西
-- 在開發者工具裡看得到，而且白白花流量。
--
-- 此檔可重複執行。

drop function if exists public.get_quiz_play_state(uuid, text);

create or replace function public.get_quiz_play_state(
  p_session_id   uuid,
  p_device_token text
)
returns table (
  phase          text,
  mode           text,
  i_am_captain   boolean,
  captain_name   text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  image_url      text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
  reveal_seconds int,
  started_at_ms  bigint,
  server_ms      bigint,
  my_choice      int,
  correct_index  int,
  my_points      int,
  my_total       int,
  show_prompt    boolean,
  show_options   boolean,
  show_chat      boolean
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    p.effective,
    coalesce(s.config->>'mode', 'team'),
    coalesce(gp.is_captain, false),
    (select c.display_name from public.game_players c
      where c.team_id = gp.team_id and c.is_captain limit 1),
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    -- 關掉就不送。前端藏起來的東西在開發者工具裡看得到，而且白花流量。
    case when p.effective = 'idle' or not d.show_prompt then null
         else q.prompt end,
    case when p.effective = 'idle' or not d.show_prompt then null
         else q.image_url end,
    case when p.effective = 'idle' or not d.show_options then null
         else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    q.reveal_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    a.choice_index,
    case when p.effective in ('reveal', 'scoreboard')
         then q.correct_index else null end,
    case when p.effective in ('reveal', 'scoreboard')
         then a.points else null end,
    -- 隊長代表賽時，手機上顯示的是全桌的分數，因為那才是「我們的」成績
    case when coalesce(s.config->>'mode', 'team') = 'captain'
         then (select coalesce(sum(t.points), 0)::int
                 from public.quiz_answers t where t.team_id = gp.team_id)
         else (select coalesce(sum(t.points), 0)::int
                 from public.quiz_answers t
                where t.session_id = s.id and t.player_id = gp.id)
    end,
    d.show_prompt,
    d.show_options,
    d.show_chat
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  left join public.game_players gp
         on gp.session_id = s.id and gp.device_token = p_device_token
  left join public.quiz_answers a
         on a.question_id = q.id and a.player_id = gp.id
  cross join lateral (
    select public.quiz_phase_at(
      s.phase,
      case when s.started_at is null or q.id is null then null
           else (extract(epoch from (clock_timestamp() - s.started_at)) * 1000)::bigint end,
      coalesce(q.prep_seconds, 0),
      coalesce(q.answer_seconds, 0),
      coalesce(q.reveal_seconds, 0)
    ) as effective
  ) p
  cross join lateral (
    select
      -- 沒設定過就用預設。舊的場次不必先去後台按一輪才能玩。
      coalesce((s.config->>'showPrompt')::boolean, false)  as show_prompt,
      coalesce((s.config->>'showOptions')::boolean, true)  as show_options,
      coalesce((s.config->>'showChat')::boolean, true)     as show_chat
  ) d
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_play_state(uuid, text) from public;
grant execute on function public.get_quiz_play_state(uuid, text)
  to anon, authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
