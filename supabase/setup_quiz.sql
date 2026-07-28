-- ============================================================
-- 海洋問答：只安裝問答需要的部分
-- ============================================================
--
-- 什麼時候用這一份：資料庫已經跑過 setup_all.sql，只是要補上問答，
-- 或是 setup_all.sql 太長、在 SQL Editor 裡跑得不安穩。
--
-- 前提：events / game_sessions / teams / game_players 已經存在。
-- 如果還沒有，請先跑 setup_all.sql。
--
-- 使用方式：
--   1. Supabase → SQL Editor → 開新查詢
--   2. 整份貼上，按 Ctrl/Cmd + A 全選
--   3. 按 Run
--   4. 看最下方的驗證結果，全部都要是「已建立」
--
-- ============================================================



-- ############################################################
-- 來源：20260728180000_q0_quiz
-- ############################################################

-- Q0：海洋問答（Kahoot 形式）
--
-- 主持人出題，大螢幕顯示題目與四個選項，玩家在手機上按對應的海洋生物。
-- 可以個人計分，也可以按桌加總成分組競賽。
--
-- 三個不可退讓的設計：
--
-- 1. 正確答案在公布之前絕對不能送到手機。任何人打開開發者工具就看得到
--    網路回應，因此 quiz_questions 對匿名端完全關閉，一切走 RPC，
--    而給手機的 RPC 在公布前不回傳 correct_index。
--
-- 2. 作答時間由伺服器計算，手機不送時間戳。讓前端報時間等於把計分權
--    交給玩家——改一下系統時間就永遠滿分。
--
-- 3. 作答視窗以題目的 started_at 推算，與 phase 無關。主持人晚一點按
--    「公布答案」不該讓遲到的作答變成有效，phase 只管畫面顯示。
--
-- 此檔可重複執行。
--
-- 所有 returns table 的函式一律先 drop 再建：Postgres 不允許用
-- create or replace 改變回傳型別，只要後面的 migration 加了一個欄位，
-- 這一份第二次執行就會整個中斷。

-- ============================================================
-- 題目
-- ============================================================

create table if not exists public.quiz_questions (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.game_sessions(id) on delete cascade,
  ordinal        int  not null,                 -- 出題順序（position 是 Postgres 保留字，不能當欄位名用在 order by）
  prompt         text not null,
  options        text[] not null,               -- 固定四個，對應四種海洋生物
  correct_index  int  not null,                 -- 0~3
  prep_seconds   int  not null default 5,       -- 開始作答前的準備時間
  answer_seconds int  not null default 20,
  points         int  not null default 1000,    -- 秒答的滿分
  created_at     timestamptz not null default now(),

  unique (session_id, ordinal),
  constraint quiz_questions_options_count
    check (array_length(options, 1) = 4),
  constraint quiz_questions_correct_range
    check (correct_index between 0 and 3),
  constraint quiz_questions_prompt_length
    check (char_length(btrim(prompt)) between 1 and 300),
  constraint quiz_questions_prep_range
    check (prep_seconds between 0 and 60),
  constraint quiz_questions_answer_range
    check (answer_seconds between 5 and 180),
  constraint quiz_questions_points_range
    check (points between 100 and 10000)
);

create index if not exists quiz_questions_session_idx
  on public.quiz_questions (session_id, ordinal);

-- ============================================================
-- 作答
-- ============================================================

create table if not exists public.quiz_answers (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.game_sessions(id) on delete cascade,
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  player_id   uuid not null references public.game_players(id) on delete cascade,
  team_id     uuid not null references public.teams(id) on delete cascade,
  choice_index int not null,
  elapsed_ms  int  not null,                    -- 從開放作答到按下去的毫秒
  is_correct  boolean not null,
  points      int  not null default 0,
  answered_at timestamptz not null default now(),

  -- 一題只能答一次，按下去就不能改
  unique (question_id, player_id),
  constraint quiz_answers_choice_range check (choice_index between 0 and 3)
);

create index if not exists quiz_answers_question_idx
  on public.quiz_answers (question_id);
create index if not exists quiz_answers_session_player_idx
  on public.quiz_answers (session_id, player_id);

-- ============================================================
-- 場次上的問答進度
-- ============================================================

alter table public.game_sessions
  add column if not exists current_question_id uuid
    references public.quiz_questions(id) on delete set null;

alter table public.game_sessions
  add column if not exists phase text not null default 'idle';

do $$
begin
  alter table public.game_sessions
    add constraint game_sessions_phase_valid
    check (phase in ('idle', 'prep', 'answer', 'reveal', 'scoreboard'));
exception when duplicate_object then null;
end $$;

-- ============================================================
-- RLS
-- ============================================================

alter table public.quiz_questions enable row level security;
alter table public.quiz_answers   enable row level security;

drop policy if exists quiz_questions_host_all on public.quiz_questions;
drop policy if exists quiz_answers_host_read  on public.quiz_answers;

-- 題目只有主持人能碰。匿名端連 select 都不給——
-- 開放讀取就等於把正確答案公開，遊戲直接失去意義。
create policy quiz_questions_host_all on public.quiz_questions
  for all to authenticated
  using (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()))
  with check (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()));

-- 作答紀錄同理：能讀就能反推別人選什麼
create policy quiz_answers_host_read on public.quiz_answers
  for select to authenticated
  using (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()));

-- ============================================================
-- 出題（主持人）
-- ============================================================

drop function if exists public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int);

create or replace function public.upsert_quiz_question(
  p_session_id     uuid,
  p_question_id    uuid,
  p_prompt         text,
  p_options        text[],
  p_correct_index  int,
  p_prep_seconds   int default 5,
  p_answer_seconds int default 20,
  p_points         int default 1000
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
           points         = p_points
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
     prep_seconds, answer_seconds, points)
  values
    (p_session_id, v_ordinal, btrim(p_prompt), p_options, p_correct_index,
     p_prep_seconds, p_answer_seconds, p_points)
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int) from public;
grant execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int) to authenticated;

-- 刪題之後把順序補回連續，否則之後新增的題目會插在奇怪的位置
create or replace function public.delete_quiz_question(p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
begin
  select q.session_id into v_session_id
    from public.quiz_questions q
    join public.game_sessions s on s.id = q.session_id
    join public.events e on e.id = s.event_id
   where q.id = p_question_id and e.host_id = auth.uid();

  if v_session_id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  delete from public.quiz_questions where id = p_question_id;

  with renumbered as (
    select id, row_number() over (order by ordinal) as rn
      from public.quiz_questions where session_id = v_session_id
  )
  update public.quiz_questions q
     set ordinal = r.rn
    from renumbered r
   where q.id = r.id and q.ordinal is distinct from r.rn;
end;
$$;

revoke execute on function public.delete_quiz_question(uuid) from public;
grant execute on function public.delete_quiz_question(uuid) to authenticated;

-- 上下移動一題
create or replace function public.move_quiz_question(
  p_question_id uuid,
  p_direction   int
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
  v_ordinal int;
  v_other_id uuid;
  v_other_ordinal int;
begin
  select q.session_id, q.ordinal into v_session_id, v_ordinal
    from public.quiz_questions q
    join public.game_sessions s on s.id = q.session_id
    join public.events e on e.id = s.event_id
   where q.id = p_question_id and e.host_id = auth.uid();

  if v_session_id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if p_direction < 0 then
    select id, ordinal into v_other_id, v_other_ordinal
      from public.quiz_questions
     where session_id = v_session_id and ordinal < v_ordinal
     order by ordinal desc limit 1;
  else
    select id, ordinal into v_other_id, v_other_ordinal
      from public.quiz_questions
     where session_id = v_session_id and ordinal > v_ordinal
     order by ordinal asc limit 1;
  end if;

  if v_other_id is null then
    return;  -- 已經在頭或尾，不是錯誤
  end if;

  -- 唯一索引擋著不能直接對調，先借一個不會撞到的暫時值
  update public.quiz_questions set ordinal = -1 where id = p_question_id;
  update public.quiz_questions set ordinal = v_ordinal where id = v_other_id;
  update public.quiz_questions set ordinal = v_other_ordinal where id = p_question_id;
end;
$$;

revoke execute on function public.move_quiz_question(uuid, int) from public;
grant execute on function public.move_quiz_question(uuid, int) to authenticated;

-- 主持人的題目清單（含正確答案）
drop function if exists public.list_quiz_questions(uuid);

create or replace function public.list_quiz_questions(p_session_id uuid)
returns table (
  id uuid,
  ordinal int,
  prompt text,
  options text[],
  correct_index int,
  prep_seconds int,
  answer_seconds int,
  points int,
  answer_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    q.id, q.ordinal, q.prompt, q.options, q.correct_index,
    q.prep_seconds, q.answer_seconds, q.points,
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
-- 出題進行（主持人）
-- ============================================================

-- 開始某一題。started_at 是這一題的時間原點：
-- 準備時間結束才開放作答，全部由 started_at 推算，
-- 因此一次寫入就涵蓋「準備」與「作答」兩個階段。
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

  update public.game_sessions
     set current_question_id = p_question_id,
         phase = 'prep',
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

-- 切換顯示階段：公布答案、看排行榜、回到待機
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
  if p_phase not in ('idle', 'prep', 'answer', 'reveal', 'scoreboard') then
    raise exception 'INVALID_PHASE';
  end if;

  update public.game_sessions s
     set phase = p_phase
   where s.id = p_session_id
     and exists (
       select 1 from public.events e
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
-- 作答（匿名）
-- ============================================================

-- 作答時間一律由伺服器算。前端只送「選了哪一個」，
-- 送出時間戳等於把計分權交給玩家。
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

  -- 給一點寬限，網路延遲不該讓壓線的作答被丟掉
  if v_elapsed > v_limit + 1500 then
    raise exception 'TOO_LATE';
  end if;

  v_elapsed := least(greatest(v_elapsed, 0), v_limit);
  v_correct := p_choice_index = v_q.correct_index;

  -- 答對的得分隨時間遞減：秒答滿分，壓線答對拿一半。
  -- 全有全無會讓慢答的人乾脆亂猜，遞減才會逼人快一點又不敢亂按。
  v_points := case
    when v_correct then greatest(1, round(v_q.points * (1 - 0.5 * v_elapsed::numeric / v_limit))::int)
    else 0
  end;

  -- 按下去就不能改。on conflict do nothing 讓重送不會報錯，
  -- 現場網路不穩時手機重試很常見。
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
-- 手機端狀態
-- ============================================================

-- 給手機的狀態。
--
-- 題目與選項文字手機上也要有：現場一定會有長輩、坐後排、
-- 或視力不好的人，只靠大螢幕等於把他們排除在遊戲外。
-- 選項文字本來就會出現在大螢幕上，送到手機不洩漏任何東西——
-- 真正不能提早送的只有 correct_index。
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
  options        text[],
  prep_seconds   int,
  answer_seconds int,
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
    s.phase,
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when s.phase = 'idle' then null else q.prompt end,
    case when s.phase = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    a.choice_index,
    case when s.phase = 'reveal' or s.phase = 'scoreboard'
         then q.correct_index else null end,
    case when s.phase = 'reveal' or s.phase = 'scoreboard'
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
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_play_state(uuid, text) from public;
grant execute on function public.get_quiz_play_state(uuid, text) to anon, authenticated;

-- ============================================================
-- 大螢幕狀態
-- ============================================================

-- 大螢幕要題目與選項文字，還要作答進度。
-- 正確答案同樣只在公布之後才回傳——大螢幕是匿名身分，
-- 提早送出去等於任何人都能先看到。
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
  options        text[],
  prep_seconds   int,
  answer_seconds int,
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
    s.phase,
    s.name,
    coalesce(s.config->>'mode', 'team'),
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    -- 題目在準備階段就要出現在大螢幕，那正是給大家讀題的時間
    case when s.phase = 'idle' then null else q.prompt end,
    case when s.phase = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    (select count(*)::int from public.quiz_answers a where a.question_id = q.id),
    (select count(*)::int from public.game_players gp where gp.session_id = s.id),
    case when s.phase in ('reveal', 'scoreboard') then q.correct_index else null end,
    -- count(a.id) 而不是 count(*)：left join 沒配對到時仍會產生一列，
    -- count(*) 會把那個空列算成 1，沒人選的選項就變成 1 票
    case when s.phase in ('reveal', 'scoreboard') then array(
      select count(a.id)::int from generate_series(0, 3) g
       left join public.quiz_answers a
              on a.question_id = q.id and a.choice_index = g
       group by g order by g
    ) else null end
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_stage_state(uuid) from public;
grant execute on function public.get_quiz_stage_state(uuid) to anon, authenticated;

-- ============================================================
-- 排行榜
-- ============================================================

drop function if exists public.quiz_individual_leaderboard(uuid, int);

create or replace function public.quiz_individual_leaderboard(
  p_session_id uuid,
  p_limit int default 10
)
returns table (
  player_id uuid,
  display_name text,
  team_name text,
  team_color text,
  total_points int,
  correct_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    gp.id, gp.display_name, t.name, t.color,
    coalesce(sum(a.points), 0)::int,
    coalesce(sum(case when a.is_correct then 1 else 0 end), 0)::int
  from public.game_players gp
  join public.teams t on t.id = gp.team_id
  left join public.quiz_answers a on a.player_id = gp.id
  where gp.session_id = p_session_id
  group by gp.id, gp.display_name, t.name, t.color
  order by 5 desc, 6 desc, gp.display_name
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

revoke execute on function public.quiz_individual_leaderboard(uuid, int) from public;
grant execute on function public.quiz_individual_leaderboard(uuid, int) to anon, authenticated;

drop function if exists public.quiz_team_leaderboard(uuid);

create or replace function public.quiz_team_leaderboard(p_session_id uuid)
returns table (
  team_id uuid,
  table_no int,
  name text,
  color text,
  creature_key text,
  player_count int,
  total_points int,
  correct_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id, t.table_no, t.name, t.color, t.creature_key, t.player_count,
    coalesce(sum(a.points), 0)::int,
    coalesce(sum(case when a.is_correct then 1 else 0 end), 0)::int
  from public.teams t
  left join public.quiz_answers a on a.team_id = t.id
  where t.session_id = p_session_id
  group by t.id, t.table_no, t.name, t.color, t.creature_key, t.player_count
  order by 7 desc, 8 desc, t.table_no;
$$;

revoke execute on function public.quiz_team_leaderboard(uuid) from public;
grant execute on function public.quiz_team_leaderboard(uuid) to anon, authenticated;


-- ############################################################
-- 來源：20260728200000_q1_quiz_images
-- ############################################################

-- Q1：題目可以配圖
--
-- 圖片放在既有的 assets 儲存桶（M8 建立，公開讀取、只有主持人能寫）。
-- 資料庫只存公開網址，不存圖片本身——與角色圖同一個原則。
--
-- 回傳欄位變了的函式一律先 drop 再建：
-- Postgres 不允許用 create or replace 改變回傳型別。
--
-- 此檔可重複執行。

alter table public.quiz_questions
  add column if not exists image_url text;

-- ============================================================
-- 出題
-- ============================================================

-- 舊簽章少一個參數，留著會變成多載，PostgREST 會不知道要呼叫哪一個
drop function if exists public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int);

create or replace function public.upsert_quiz_question(
  p_session_id     uuid,
  p_question_id    uuid,
  p_prompt         text,
  p_options        text[],
  p_correct_index  int,
  p_prep_seconds   int default 5,
  p_answer_seconds int default 20,
  p_points         int default 1000,
  p_image_url      text default null
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
     prep_seconds, answer_seconds, points, image_url)
  values
    (p_session_id, v_ordinal, btrim(p_prompt), p_options, p_correct_index,
     p_prep_seconds, p_answer_seconds, p_points,
     nullif(btrim(coalesce(p_image_url, '')), ''))
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text) from public;
grant execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text) to authenticated;

-- ============================================================
-- 查詢：補上 image_url
-- ============================================================

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
    q.prep_seconds, q.answer_seconds, q.points,
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
    s.phase,
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when s.phase = 'idle' then null else q.prompt end,
    case when s.phase = 'idle' then null else q.image_url end,
    case when s.phase = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    a.choice_index,
    case when s.phase = 'reveal' or s.phase = 'scoreboard'
         then q.correct_index else null end,
    case when s.phase = 'reveal' or s.phase = 'scoreboard'
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
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_play_state(uuid, text) from public;
grant execute on function public.get_quiz_play_state(uuid, text) to anon, authenticated;

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
    s.phase,
    s.name,
    coalesce(s.config->>'mode', 'team'),
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when s.phase = 'idle' then null else q.prompt end,
    case when s.phase = 'idle' then null else q.image_url end,
    case when s.phase = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    (select count(*)::int from public.quiz_answers a where a.question_id = q.id),
    (select count(*)::int from public.game_players gp where gp.session_id = s.id),
    case when s.phase in ('reveal', 'scoreboard') then q.correct_index else null end,
    -- count(a.id) 而不是 count(*)：left join 沒配對到時仍會產生一列，
    -- count(*) 會把那個空列算成 1，沒人選的選項就變成 1 票
    case when s.phase in ('reveal', 'scoreboard') then array(
      select count(a.id)::int from generate_series(0, 3) g
       left join public.quiz_answers a
              on a.question_id = q.id and a.choice_index = g
       group by g order by g
    ) else null end
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_stage_state(uuid) from public;
grant execute on function public.get_quiz_stage_state(uuid) to anon, authenticated;


-- ############################################################
-- 來源：20260728220000_q2_auto_phase
-- ############################################################

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
-- 重載 PostgREST 結構快取
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');

-- ============================================================
-- 驗證：函式在不在，以及前端的身分有沒有權限呼叫
-- ============================================================
-- 「缺少」代表這份腳本沒跑完。
-- 「沒有權限」代表建立了但 grant 沒生效，PostgREST 一樣會說找不到。
with expected(fn, who) as (
  values
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
    ('quiz_team_leaderboard',       'anon')
)
select
  e.fn as 函式名稱,
  case
    when p.oid is null then '缺少'
    when not has_function_privilege(e.who, p.oid, 'execute') then '沒有權限'
    else '已建立'
  end as 狀態
from expected e
left join pg_proc p
       on p.proname = e.fn and p.pronamespace = 'public'::regnamespace
order by 狀態, e.fn;

-- 問答的資料表
with expected(obj) as (values ('quiz_questions'), ('quiz_answers'))
select
  e.obj as 資料表,
  case when c.oid is null then '缺少' else '已建立' end as 狀態
from expected e
left join pg_class c
       on c.relname = e.obj
      and c.relnamespace = 'public'::regnamespace
      and c.relkind = 'r'
order by 狀態, e.obj;
