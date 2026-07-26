-- M6：主持人端
--
-- 內容：活動建立 RPC（產生不重複短碼）、既有活動的 host 認領、
-- 大螢幕的活動存取政策調整。
--
-- 此檔可重複執行。

-- ============================================================
-- 短碼產生
-- ============================================================

-- 排除易混淆字元（0/O、1/I）的字母數字集合，現場口述與手動輸入才不會出錯
create or replace function public.generate_event_code()
returns text
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_attempt int := 0;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;

    exit when not exists (select 1 from public.events e where e.code = v_code);

    v_attempt := v_attempt + 1;
    if v_attempt > 50 then
      raise exception 'CODE_GENERATION_FAILED';
    end if;
  end loop;

  return v_code;
end;
$$;

-- ============================================================
-- 建立活動
-- ============================================================

-- 以 RPC 而非直接 insert：短碼必須由伺服器產生並保證唯一，
-- 不能讓前端自行決定。回傳完整活動列供主持人端直接使用。
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
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  insert into public.events (code, name, subtitle, world_template, draw_count, allow_repeat, status, host_id)
  values (
    public.generate_event_code(),
    btrim(p_name),
    nullif(btrim(coalesce(p_subtitle, '')), ''),
    coalesce(p_world_template, 'ocean'),
    greatest(1, least(coalesce(p_draw_count, 1), 100)),
    coalesce(p_allow_repeat, false),
    'draft',
    auth.uid()
  )
  returning * into v_event;

  return v_event;
end;
$$;

revoke execute on function public.create_event(text, text, text, int, boolean) from public;
grant execute on function public.create_event(text, text, text, int, boolean) to authenticated;

-- ============================================================
-- 認領無主活動
-- ============================================================

-- M1 的種子活動 DEMO01 沒有 host_id，任何登入的主持人都無法管理它。
-- 這支讓第一位登入者認領無主活動，避免測試資料變成孤兒。
-- 已有 host 的活動不受影響。
create or replace function public.claim_event(p_code text)
returns public.events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.events
     set host_id = auth.uid()
   where code = upper(btrim(p_code))
     and host_id is null
  returning * into v_event;

  if v_event.id is null then
    raise exception 'EVENT_NOT_CLAIMABLE';
  end if;

  return v_event;
end;
$$;

revoke execute on function public.claim_event(text) from public;
grant execute on function public.claim_event(text) to authenticated;

-- ============================================================
-- 主持人的活動清單
-- ============================================================

-- events 的 RLS 已允許主持人讀取自己的活動，這支只是加上排序與
-- 待抽人數等衍生欄位，讓清單頁一次查完
create or replace function public.list_my_events()
returns table (
  id uuid,
  code text,
  name text,
  subtitle text,
  world_template text,
  draw_count int,
  allow_repeat boolean,
  status text,
  participant_count int,
  drawn_count bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    e.id, e.code, e.name, e.subtitle, e.world_template,
    e.draw_count, e.allow_repeat, e.status, e.participant_count,
    (select count(*) from public.draws d where d.event_id = e.id and d.voided_at is null),
    e.created_at
  from public.events e
  where e.host_id = auth.uid()
  order by e.created_at desc;
$$;

revoke execute on function public.list_my_events() from public;
grant execute on function public.list_my_events() to authenticated;

-- ============================================================
-- 主持人的參與者清單
-- ============================================================

-- 與大螢幕的 get_stage_participants 不同：主持人需要看到已隱藏的角色
-- 才能取消隱藏，也需要 is_eligible 來排除特定人。
-- 仍不回傳 device_token。
create or replace function public.list_event_participants(p_event_id uuid)
returns table (
  id uuid,
  display_name text,
  character_name text,
  image_path text,
  is_visible boolean,
  is_eligible boolean,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.display_name, p.character_name, p.image_path,
         p.is_visible, p.is_eligible, p.joined_at
    from public.participants p
   where p.event_id = p_event_id
     and exists (
       select 1 from public.events e
        where e.id = p_event_id and e.host_id = auth.uid()
     )
   order by p.joined_at desc;
$$;

revoke execute on function public.list_event_participants(uuid) from public;
grant execute on function public.list_event_participants(uuid) to authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
-- 少了這一行，新建立的函式要等快取自然過期才會生效，
-- 前端會收到「找不到函式 ...（schema cache）」。
notify pgrst, 'reload schema';
