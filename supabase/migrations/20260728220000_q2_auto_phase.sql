-- Q2：階段自動推進
--
-- 原本主持人要按三次：開始 → 公布答案 → 看排行榜。
-- 現場主持人一手拿麥克風、一手拿手機、面對兩百個人，
-- 記得按第二第三下這件事本身就是設計缺陷。
--
-- 改成：主持人只按「下一題」，之後全部由時間推進：
--   讀題倒數 → 作答 → 自動公布正確答案 → 自動顯示各組分數
--
-- 關鍵設計：階段不再是資料庫裡的一個狀態，而是從 started_at「算」出來的。
-- 這樣手機、大螢幕、主持人後台三邊永遠一致，中間也不需要任何人
-- 在正確的時間點寫入資料庫——那個寫入一旦漏掉（分頁被切到背景、
-- 網路斷一下），全場就卡在作答畫面出不來。
--
-- 儲存的 phase 只剩一個用途：主持人強制回到待機畫面。
--
-- 此檔可重複執行。

-- 公布正確答案要停留多久才跳到分數
alter table public.quiz_questions
  add column if not exists reveal_seconds int not null default 6;

do $$
begin
  alter table public.quiz_questions
    add constraint quiz_questions_reveal_range
    check (reveal_seconds between 2 and 60);
exception when duplicate_object then null;
end $$;

-- ============================================================
-- 由時間推算階段
-- ============================================================

-- 作答截止之後的寬限期。
--
-- 存在的理由：有人在最後一刻按下去，但封包晚了兩百毫秒才到伺服器，
-- 那一下不該被丟掉。
--
-- 但寬限期一定要落在「公布答案」之前——否則大螢幕已經把正解打出來，
-- 卻還收得到作答，那就不是寬容而是漏洞。所以判定與畫面共用這一個值。
create or replace function public.quiz_answer_grace_ms()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 1500 $$;

revoke execute on function public.quiz_answer_grace_ms() from public;
grant execute on function public.quiz_answer_grace_ms() to anon, authenticated;

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
-- 作答檢查改用共用的寬限期
-- ============================================================

drop function if exists public.submit_quiz_answer(uuid, text, int);

create or replace function public.submit_quiz_answer(
  p_question_id  uuid,
  p_device_token text,
  p_choice_index int
)
returns table (accepted boolean, elapsed_ms int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_q public.quiz_questions;
  v_session public.game_sessions;
  v_player public.game_players;
  v_open_at timestamptz;
  v_elapsed int;
  v_limit int;
  v_correct boolean;
  v_points int;
begin
  if p_choice_index is null or p_choice_index < 0 or p_choice_index > 3 then
    raise exception 'INVALID_CHOICE';
  end if;

  select * into v_q from public.quiz_questions q where q.id = p_question_id;
  if v_q.id is null then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  select * into v_session from public.game_sessions s where s.id = v_q.session_id;

  -- 只有「正在進行的那一題」能作答，不能挑舊題目補答
  if v_session.current_question_id is distinct from p_question_id
     or v_session.started_at is null then
    raise exception 'QUESTION_NOT_ACTIVE';
  end if;

  -- 主持人按了回到待機就不再收
  if v_session.phase = 'idle' then
    raise exception 'QUESTION_NOT_ACTIVE';
  end if;

  select * into v_player from public.game_players gp
   where gp.session_id = v_session.id and gp.device_token = p_device_token;
  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  v_open_at := v_session.started_at + make_interval(secs => v_q.prep_seconds);
  v_limit := v_q.answer_seconds * 1000;
  v_elapsed := floor(
    extract(epoch from (clock_timestamp() - v_open_at)) * 1000
  )::int;

  if v_elapsed < -150 then
    raise exception 'ANSWER_NOT_OPEN';
  end if;

  -- 與 quiz_phase_at 共用同一個寬限期，畫面與判定才不會各說各話：
  -- 大螢幕跳出正解的那一刻，就是這裡開始拒收的那一刻
  if v_elapsed > v_limit + public.quiz_answer_grace_ms() then
    raise exception 'TOO_LATE';
  end if;

  v_elapsed := least(greatest(v_elapsed, 0), v_limit);
  v_correct := p_choice_index = v_q.correct_index;

  -- 答對的得分隨時間遞減：秒答滿分，壓線答對拿一半
  v_points := case
    when v_correct then greatest(1, round(v_q.points * (1 - 0.5 * v_elapsed::numeric / v_limit))::int)
    else 0
  end;

  insert into public.quiz_answers
    (session_id, question_id, player_id, team_id, choice_index,
     elapsed_ms, is_correct, points)
  values
    (v_session.id, p_question_id, v_player.id, v_player.team_id, p_choice_index,
     v_elapsed, v_correct, v_points)
  on conflict (question_id, player_id) do nothing;

  return query select true, v_elapsed;
end;
$$;

revoke execute on function public.submit_quiz_answer(uuid, text, int) from public;
grant execute on function public.submit_quiz_answer(uuid, text, int) to anon, authenticated;

-- ============================================================
-- 提前結束作答
-- ============================================================

-- 主持人想早點收的時候用。作法是把 started_at 往前挪，
-- 讓「已經過了作答時間」這件事對所有人同時成立——
-- 包含 submit_quiz_answer 的時間檢查，所以早收之後就再也送不進來。
-- 若改成寫一個 phase 旗標，作答檢查與畫面顯示會用兩套規則，
-- 那正是「畫面說結束了但還收得到答案」的來源。
create or replace function public.end_answer_early(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_q public.quiz_questions;
  v_session public.game_sessions;
begin
  select * into v_session from public.game_sessions s
   where s.id = p_session_id
     and exists (select 1 from public.events e
                  where e.id = s.event_id and e.host_id = auth.uid());

  if v_session.id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  select * into v_q from public.quiz_questions q
   where q.id = v_session.current_question_id;

  if v_q.id is null or v_session.started_at is null then
    return;
  end if;

  update public.game_sessions
     set started_at = clock_timestamp()
                    - make_interval(secs => v_q.prep_seconds + v_q.answer_seconds)
   where id = p_session_id;

  perform realtime.send(
    jsonb_build_object('session_id', p_session_id, 'phase', 'reveal'),
    'quiz:phase', 'game:' || p_session_id, false);
end;
$$;

revoke execute on function public.end_answer_early(uuid) from public;
grant execute on function public.end_answer_early(uuid) to authenticated;

-- ============================================================
-- 出題：補上 reveal_seconds
-- ============================================================

drop function if exists public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text);

create or replace function public.upsert_quiz_question(
  p_session_id     uuid,
  p_question_id    uuid,
  p_prompt         text,
  p_options        text[],
  p_correct_index  int,
  p_prep_seconds   int default 5,
  p_answer_seconds int default 20,
  p_points         int default 1000,
  p_image_url      text default null,
  p_reveal_seconds int default 6
)
returns public.quiz_questions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.quiz_questions;
  v_ordinal int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if p_question_id is not null then
    update public.quiz_questions
       set prompt         = btrim(p_prompt),
           options        = p_options,
           correct_index  = p_correct_index,
           prep_seconds   = p_prep_seconds,
           answer_seconds = p_answer_seconds,
           reveal_seconds = p_reveal_seconds,
           points         = p_points,
           image_url      = nullif(btrim(coalesce(p_image_url, '')), '')
     where id = p_question_id and session_id = p_session_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'QUESTION_NOT_FOUND';
    end if;
    return v_row;
  end if;

  select coalesce(max(q.ordinal), 0) + 1 into v_ordinal
    from public.quiz_questions q where q.session_id = p_session_id;

  insert into public.quiz_questions
    (session_id, ordinal, prompt, options, correct_index,
     prep_seconds, answer_seconds, reveal_seconds, points, image_url)
  values
    (p_session_id, v_ordinal, btrim(p_prompt), p_options, p_correct_index,
     p_prep_seconds, p_answer_seconds, p_reveal_seconds, p_points,
     nullif(btrim(coalesce(p_image_url, '')), ''))
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text, int) from public;
grant execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text, int) to authenticated;

drop function if exists public.list_quiz_questions(uuid);

create or replace function public.list_quiz_questions(p_session_id uuid)
returns table (
  id uuid,
  ordinal int,
  prompt text,
  image_url text,
  options text[],
  correct_index int,
  prep_seconds int,
  answer_seconds int,
  reveal_seconds int,
  points int,
  answer_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    q.id, q.ordinal, q.prompt, q.image_url, q.options, q.correct_index,
    q.prep_seconds, q.answer_seconds, q.reveal_seconds, q.points,
    (select count(*) from public.quiz_answers a where a.question_id = q.id)
  from public.quiz_questions q
  where q.session_id = p_session_id
    and exists (
      select 1 from public.game_sessions s
        join public.events e on e.id = s.event_id
       where s.id = p_session_id and e.host_id = auth.uid())
  order by q.ordinal;
$$;

revoke execute on function public.list_quiz_questions(uuid) from public;
grant execute on function public.list_quiz_questions(uuid) to authenticated;

-- ============================================================
-- 手機端狀態：階段由時間算
-- ============================================================

drop function if exists public.get_quiz_play_state(uuid, text);

create or replace function public.get_quiz_play_state(
  p_session_id   uuid,
  p_device_token text
)
returns table (
  phase          text,
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
  my_total       int
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    p.effective,
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when p.effective = 'idle' then null else q.prompt end,
    case when p.effective = 'idle' then null else q.image_url end,
    case when p.effective = 'idle' then null else q.options end,
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
    (select coalesce(sum(t.points), 0)::int
       from public.quiz_answers t
      where t.session_id = s.id and t.player_id = gp.id)
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
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_play_state(uuid, text) from public;
grant execute on function public.get_quiz_play_state(uuid, text) to anon, authenticated;

-- ============================================================
-- 大螢幕狀態：階段由時間算
-- ============================================================

drop function if exists public.get_quiz_stage_state(uuid);

create or replace function public.get_quiz_stage_state(p_session_id uuid)
returns table (
  phase          text,
  session_name   text,
  mode           text,
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
  answered_count int,
  player_count   int,
  correct_index  int,
  option_counts  int[]
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    p.effective,
    s.name,
    coalesce(s.config->>'mode', 'team'),
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when p.effective = 'idle' then null else q.prompt end,
    case when p.effective = 'idle' then null else q.image_url end,
    case when p.effective = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    q.reveal_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    (select count(*)::int from public.quiz_answers a where a.question_id = q.id),
    (select count(*)::int from public.game_players gp where gp.session_id = s.id),
    case when p.effective in ('reveal', 'scoreboard') then q.correct_index else null end,
    -- count(a.id) 而不是 count(*)：left join 沒配對到時仍會產生一列，
    -- count(*) 會把那個空列算成 1，沒人選的選項就變成 1 票
    case when p.effective in ('reveal', 'scoreboard') then array(
      select count(a.id)::int from generate_series(0, 3) g
       left join public.quiz_answers a
              on a.question_id = q.id and a.choice_index = g
       group by g order by g
    ) else null end
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
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
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_stage_state(uuid) from public;
grant execute on function public.get_quiz_stage_state(uuid) to anon, authenticated;

-- ============================================================
-- 開始一題時把強制待機解除
-- ============================================================

drop function if exists public.start_quiz_question(uuid, uuid);

create or replace function public.start_quiz_question(
  p_session_id  uuid,
  p_question_id uuid
)
returns table (started_at_ms bigint, server_ms bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_started timestamptz;
begin
  if not exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if not exists (
    select 1 from public.quiz_questions q
     where q.id = p_question_id and q.session_id = p_session_id
  ) then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  v_started := clock_timestamp();

  -- phase 寫成 'auto' 代表「照時間走」，只有 'idle' 會強制回待機
  update public.game_sessions
     set current_question_id = p_question_id,
         phase = 'auto',
         started_at = v_started,
         status = 'playing'
   where id = p_session_id;

  perform realtime.send(
    jsonb_build_object(
      'session_id', p_session_id,
      'question_id', p_question_id,
      'started_at_ms', (extract(epoch from v_started) * 1000)::bigint
    ),
    'quiz:question', 'game:' || p_session_id, false);

  return query select
    (extract(epoch from v_started) * 1000)::bigint,
    (extract(epoch from clock_timestamp()) * 1000)::bigint;
end;
$$;

revoke execute on function public.start_quiz_question(uuid, uuid) from public;
grant execute on function public.start_quiz_question(uuid, uuid) to authenticated;

-- 'auto' 是新的合法值，舊的檢查約束會擋下來
alter table public.game_sessions drop constraint if exists game_sessions_phase_valid;
alter table public.game_sessions
  add constraint game_sessions_phase_valid
  check (phase in ('idle', 'auto', 'prep', 'answer', 'reveal', 'scoreboard'));

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
-- 少了這一步，被 drop 再建的函式要等快取自然過期才會生效，
-- 前端在那之前一律收到「在模式快取中找不到函式 ...」。
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');

-- ============================================================
-- 驗證
-- ============================================================
select
  public.quiz_phase_at('auto', 2000, 5, 20, 6)  as "2 秒：讀題",
  public.quiz_phase_at('auto', 9000, 5, 20, 6)  as "9 秒：作答",
  public.quiz_phase_at('auto', 27000, 5, 20, 6) as "27 秒：公布",
  public.quiz_phase_at('auto', 33000, 5, 20, 6) as "33 秒：排行",
  public.quiz_phase_at('idle', 9000, 5, 20, 6)  as "強制待機";
