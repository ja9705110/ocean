-- G1：對時與回合節拍
--
-- 節奏遊戲的一切都建立在「每支手機都同意現在幾點」之上。
-- 手機的系統時間可能差好幾秒（沒對時、時區設錯、使用者自己改過），
-- 直接拿 Date.now() 判定節拍會讓整桌人明明划得很準卻全是 Miss。
--
-- 作法：
-- 1. server_now() 回傳伺服器的 epoch 毫秒，手機量測往返時間後推算時差。
-- 2. 回合的起始時間由 start_round() 在伺服器端寫入，
--    絕不能讓主持人的裝置決定——主持人的時鐘一樣不可信。
-- 3. started_at 刻意設在未來（前導時間），手機拿到後自己倒數，
--    不需要第二次寫入來把狀態從「倒數」翻成「進行中」。
--
-- 此檔可重複執行。

-- ============================================================
-- 伺服器時間
-- ============================================================

-- 用 clock_timestamp() 而非 now()：now() 是交易開始時間，
-- 在連線池排隊時會偏早，那正是我們要量測的誤差來源。
create or replace function public.server_now()
returns bigint
language sql
volatile
set search_path = public, pg_temp
as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

revoke execute on function public.server_now() from public;
grant execute on function public.server_now() to anon, authenticated;

-- ============================================================
-- 回合控制
-- ============================================================

-- 開始新回合。started_at 設在 p_lead_in_ms 之後，
-- 讓所有手機有時間收到、對時、把手擺好，並在畫面上一起倒數。
create or replace function public.start_round(
  p_session_id  uuid,
  p_lead_in_ms  int default 6000
)
returns public.game_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
  v_lead_in int := least(greatest(coalesce(p_lead_in_ms, 6000), 0), 60000);
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.game_sessions s
     set round_no   = s.round_no + 1,
         started_at = clock_timestamp() + make_interval(secs => v_lead_in / 1000.0),
         status     = 'playing'
   where s.id = p_session_id
     and exists (
       select 1 from public.events e
        where e.id = s.event_id and e.host_id = auth.uid()
     )
  returning * into v_session;

  if v_session.id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  perform realtime.send(
    jsonb_build_object(
      'session_id', v_session.id,
      'round_no',   v_session.round_no,
      'game_key',   v_session.game_key,
      'started_at_ms', (extract(epoch from v_session.started_at) * 1000)::bigint,
      'config',     v_session.config
    ),
    'round:started',
    'game:' || v_session.id,
    false
  );

  return v_session;
end;
$$;

revoke execute on function public.start_round(uuid, int) from public;
grant execute on function public.start_round(uuid, int) to authenticated;

-- 收回本回合，回到大廳。主持人喊卡、或是要重跑一次時用。
create or replace function public.end_round(p_session_id uuid)
returns public.game_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.game_sessions s
     set started_at = null,
         status     = 'lobby'
   where s.id = p_session_id
     and exists (
       select 1 from public.events e
        where e.id = s.event_id and e.host_id = auth.uid()
     )
  returning * into v_session;

  if v_session.id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  perform realtime.send(
    jsonb_build_object('session_id', v_session.id, 'round_no', v_session.round_no),
    'round:ended',
    'game:' || v_session.id,
    false
  );

  return v_session;
end;
$$;

revoke execute on function public.end_round(uuid) from public;
grant execute on function public.end_round(uuid) to authenticated;

-- ============================================================
-- 手機端的回合狀態
-- ============================================================

-- 手機在大廳輪詢這一支，知道「開始了沒、第幾回合、第 0 拍是什麼時候」。
-- 時間一律以 epoch 毫秒回傳，與 server_now() 同一個單位，
-- 手機那端不必再處理時區字串。
create or replace function public.get_play_state(p_session_id uuid)
returns table (
  status        text,
  round_no      int,
  game_key      text,
  started_at_ms bigint,
  config        jsonb,
  server_ms     bigint
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    s.status,
    s.round_no,
    s.game_key,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    s.config,
    (extract(epoch from clock_timestamp()) * 1000)::bigint
  from public.game_sessions s
  where s.id = p_session_id;
$$;

revoke execute on function public.get_play_state(uuid) from public;
grant execute on function public.get_play_state(uuid) to anon, authenticated;

-- ============================================================
-- 主持人場次清單：補上 started_at
-- ============================================================

-- 回傳型別變了，Postgres 不允許用 create or replace 改，必須先移除。
drop function if exists public.list_event_game_sessions(uuid);

create or replace function public.list_event_game_sessions(p_event_id uuid)
returns table (
  id uuid,
  game_key text,
  name text,
  status text,
  round_no int,
  config jsonb,
  started_at_ms bigint,
  team_count bigint,
  player_count bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.id, s.game_key, s.name, s.status, s.round_no, s.config,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (select count(*) from public.teams t where t.session_id = s.id),
    (select count(*) from public.game_players gp where gp.session_id = s.id),
    s.created_at
  from public.game_sessions s
  where s.event_id = p_event_id
    and exists (select 1 from public.events e where e.id = p_event_id and e.host_id = auth.uid())
  order by s.created_at desc;
$$;

revoke execute on function public.list_event_game_sessions(uuid) from public;
grant execute on function public.list_event_game_sessions(uuid) to authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';

-- ============================================================
-- 驗證
-- ============================================================
with expected(fn) as (
  values ('server_now'), ('start_round'), ('end_round'),
         ('get_play_state'), ('list_event_game_sessions')
)
select
  e.fn as 函式名稱,
  case when p.oid is null then '缺少' else '已建立' end as 狀態
from expected e
left join pg_proc p
       on p.proname = e.fn and p.pronamespace = 'public'::regnamespace
order by 狀態, e.fn;
