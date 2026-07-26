-- M7：獎項與抽獎
--
-- 把單一的 events.draw_count 擴充為獎項清單：每個獎項有名稱與名額，
-- 抽獎依序逐一獎項進行。draws 記錄該筆中獎屬於哪個獎項。
--
-- 核心原則（規格第 11 節）：中獎者一律由資料庫決定，
-- 前端只負責播動畫。draws 表是唯一真實來源，重整不會改變結果。
--
-- 此檔可重複執行。

-- ============================================================
-- 獎項
-- ============================================================

create table if not exists public.prizes (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  name       text not null,                 -- 獎項名稱，例如「頭獎 掃地機器人」
  quantity   int  not null default 1,       -- 這個獎項要抽幾位
  sort_order int  not null default 0,       -- 抽獎順序，小的先抽
  created_at timestamptz not null default now(),

  constraint prizes_name_length check (char_length(btrim(name)) between 1 and 40),
  constraint prizes_quantity_range check (quantity between 1 and 500)
);

create index if not exists prizes_event_order_idx
  on public.prizes (event_id, sort_order, created_at);

-- draws 增加獎項關聯。nullable：M7 之前的既有資料沒有獎項。
alter table public.draws
  add column if not exists prize_id uuid references public.prizes(id) on delete set null;

create index if not exists draws_prize_idx on public.draws (prize_id);

-- ============================================================
-- 獎項的 RLS
-- ============================================================

alter table public.prizes enable row level security;

drop policy if exists prizes_public_read on public.prizes;
drop policy if exists prizes_host_all on public.prizes;

-- 匿名端唯讀：大螢幕與手機需要顯示「目前抽的是什麼獎」
create policy prizes_public_read on public.prizes
  for select to anon, authenticated
  using (true);

create policy prizes_host_all on public.prizes
  for all to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()))
  with check (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

-- ============================================================
-- 建立活動時自動帶一個預設獎項
-- ============================================================

-- 讓「建立活動後就能直接抽獎」成立，主持人再視需要改名稱、加獎項。
-- 名額沿用表單上填的預計抽出人數。
create or replace function public.create_event(
  p_name           text,
  p_subtitle       text default null,
  p_world_template text default 'ocean',
  p_draw_count     int  default 1,
  p_allow_repeat   boolean default false
)
returns public.events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events;
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  v_count := greatest(1, least(coalesce(p_draw_count, 1), 100));

  insert into public.events (code, name, subtitle, world_template, draw_count, allow_repeat, status, host_id)
  values (
    public.generate_event_code(),
    btrim(p_name),
    nullif(btrim(coalesce(p_subtitle, '')), ''),
    coalesce(p_world_template, 'ocean'),
    v_count,
    coalesce(p_allow_repeat, false),
    'draft',
    auth.uid()
  )
  returning * into v_event;

  insert into public.prizes (event_id, name, quantity, sort_order)
  values (v_event.id, '中獎', v_count, 0);

  return v_event;
end;
$$;

revoke execute on function public.create_event(text, text, text, int, boolean) from public;
grant execute on function public.create_event(text, text, text, int, boolean) to authenticated;

-- ============================================================
-- 獎項清單（含抽獎進度）
-- ============================================================

create or replace function public.list_event_prizes(p_event_id uuid)
returns table (
  id uuid,
  name text,
  quantity int,
  sort_order int,
  drawn_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id, p.name, p.quantity, p.sort_order,
    (select count(*) from public.draws d
      where d.prize_id = p.id and d.voided_at is null)
  from public.prizes p
  where p.event_id = p_event_id
  order by p.sort_order, p.created_at;
$$;

revoke execute on function public.list_event_prizes(uuid) from public;
grant execute on function public.list_event_prizes(uuid) to anon, authenticated;

-- ============================================================
-- 抽獎結果清單
-- ============================================================

create or replace function public.list_event_draws(p_event_id uuid)
returns table (
  id uuid,
  round_no int,
  prize_id uuid,
  prize_name text,
  participant_id uuid,
  display_name text,
  character_name text,
  image_path text,
  drawn_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    d.id, d.round_no, d.prize_id,
    coalesce(pz.name, '中獎'),
    d.participant_id, pa.display_name, pa.character_name, pa.image_path,
    d.drawn_at
  from public.draws d
  join public.participants pa on pa.id = d.participant_id
  left join public.prizes pz on pz.id = d.prize_id
  where d.event_id = p_event_id
    and d.voided_at is null
  order by d.round_no;
$$;

revoke execute on function public.list_event_draws(uuid) from public;
grant execute on function public.list_event_draws(uuid) to anon, authenticated;

-- ============================================================
-- 抽獎（伺服器端決定）
-- ============================================================

-- 規格第 11 節：前端絕對不能自己 random。
--
-- 併發保護用 advisory lock 而非 for update：真正要序列化的是
-- 「算出下一個 round_no → 插入」這整段，鎖住某一列參與者並不能防止
-- 兩位主持人同時按下抽獎而產生重複輪次。
create or replace function public.draw_winner(p_event_id uuid, p_prize_id uuid)
returns table (
  draw_id uuid,
  round_no int,
  prize_id uuid,
  prize_name text,
  participant_id uuid,
  display_name text,
  character_name text,
  image_path text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_host boolean;
  v_allow_repeat boolean;
  v_prize public.prizes;
  v_drawn int;
  v_round int;
  v_winner public.participants;
  v_draw_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select (e.host_id = auth.uid()), e.allow_repeat
    into v_is_host, v_allow_repeat
    from public.events e
   where e.id = p_event_id;

  if v_is_host is not true then
    raise exception 'NOT_EVENT_HOST';
  end if;

  -- 序列化同一活動的抽獎，交易結束自動釋放
  perform pg_advisory_xact_lock(hashtext(p_event_id::text));

  select * into v_prize
    from public.prizes pz
   where pz.id = p_prize_id and pz.event_id = p_event_id;

  if v_prize.id is null then
    raise exception 'PRIZE_NOT_FOUND';
  end if;

  select count(*) into v_drawn
    from public.draws d
   where d.prize_id = v_prize.id and d.voided_at is null;

  if v_drawn >= v_prize.quantity then
    raise exception 'PRIZE_QUOTA_REACHED';
  end if;

  select p.* into v_winner
    from public.participants p
   where p.event_id = p_event_id
     and p.is_eligible
     and p.is_visible
     and (
       v_allow_repeat
       or not exists (
         select 1 from public.draws d
          where d.participant_id = p.id and d.voided_at is null
       )
     )
   order by random()
   limit 1;

  if v_winner.id is null then
    raise exception 'NO_ELIGIBLE_PARTICIPANT';
  end if;

  select coalesce(max(d.round_no), 0) + 1 into v_round
    from public.draws d
   where d.event_id = p_event_id;

  insert into public.draws (event_id, round_no, participant_id, prize_id)
  values (p_event_id, v_round, v_winner.id, v_prize.id)
  returning id into v_draw_id;

  -- 直接由資料庫廣播給大螢幕：不依賴主持人裝置的連線狀態，
  -- 主持人端當掉或重整都不影響大螢幕收到結果
  perform realtime.send(
    jsonb_build_object(
      'draw_id', v_draw_id,
      'round_no', v_round,
      'prize_id', v_prize.id,
      'prize_name', v_prize.name,
      'participant_id', v_winner.id,
      'display_name', v_winner.display_name,
      'character_name', v_winner.character_name,
      'image_path', v_winner.image_path
    ),
    'draw:reveal',
    'event:' || p_event_id,
    false
  );

  return query
    select v_draw_id, v_round, v_prize.id, v_prize.name,
           v_winner.id, v_winner.display_name, v_winner.character_name,
           v_winner.image_path;
end;
$$;

revoke execute on function public.draw_winner(uuid, uuid) from public;
grant execute on function public.draw_winner(uuid, uuid) to authenticated;

-- ============================================================
-- 作廢一輪（現場按錯、或中獎者已離場）
-- ============================================================

create or replace function public.void_draw(p_draw_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_is_host boolean;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select d.event_id into v_event_id from public.draws d where d.id = p_draw_id;
  if v_event_id is null then
    raise exception 'DRAW_NOT_FOUND';
  end if;

  select (e.host_id = auth.uid()) into v_is_host
    from public.events e where e.id = v_event_id;

  if v_is_host is not true then
    raise exception 'NOT_EVENT_HOST';
  end if;

  update public.draws set voided_at = now()
   where id = p_draw_id and voided_at is null;

  perform realtime.send(
    jsonb_build_object('draw_id', p_draw_id),
    'draw:voided',
    'event:' || v_event_id,
    false
  );
end;
$$;

revoke execute on function public.void_draw(uuid) from public;
grant execute on function public.void_draw(uuid) to authenticated;

-- ============================================================
-- 重播中獎動畫（投影當機後補救）
-- ============================================================

create or replace function public.replay_draw(p_draw_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select d.id as draw_id, d.round_no, d.event_id,
         pz.id as prize_id, coalesce(pz.name, '中獎') as prize_name,
         pa.id as participant_id, pa.display_name, pa.character_name, pa.image_path,
         (e.host_id = auth.uid()) as is_host
    into v_row
    from public.draws d
    join public.participants pa on pa.id = d.participant_id
    join public.events e on e.id = d.event_id
    left join public.prizes pz on pz.id = d.prize_id
   where d.id = p_draw_id and d.voided_at is null;

  if v_row.draw_id is null then
    raise exception 'DRAW_NOT_FOUND';
  end if;
  if v_row.is_host is not true then
    raise exception 'NOT_EVENT_HOST';
  end if;

  perform realtime.send(
    jsonb_build_object(
      'draw_id', v_row.draw_id,
      'round_no', v_row.round_no,
      'prize_id', v_row.prize_id,
      'prize_name', v_row.prize_name,
      'participant_id', v_row.participant_id,
      'display_name', v_row.display_name,
      'character_name', v_row.character_name,
      'image_path', v_row.image_path
    ),
    'draw:reveal',
    'event:' || v_row.event_id,
    false
  );
end;
$$;

revoke execute on function public.replay_draw(uuid) from public;
grant execute on function public.replay_draw(uuid) to authenticated;

-- ============================================================
-- 為既有活動補上預設獎項
-- ============================================================

-- M7 之前建立的活動沒有任何獎項，補一個以維持可抽獎狀態
insert into public.prizes (event_id, name, quantity, sort_order)
select e.id, '中獎', greatest(e.draw_count, 1), 0
  from public.events e
 where not exists (select 1 from public.prizes p where p.event_id = e.id);

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';

-- ============================================================
-- 驗證
-- ============================================================
with expected(fn) as (
  values ('list_event_prizes'), ('list_event_draws'),
         ('draw_winner'), ('void_draw'), ('replay_draw')
)
select
  e.fn as 函式名稱,
  case when p.oid is null then '缺少' else '已建立' end as 狀態
from expected e
left join pg_proc p
       on p.proname = e.fn and p.pronamespace = 'public'::regnamespace
order by e.fn;
