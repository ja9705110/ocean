-- C34：現場要收拾的四件事
--
-- 1. 報到者可以刪、可以整批清掉
-- 2. 餅乾照片可以改署名
-- 3. 餅乾照片可以真的刪掉（連 Storage 裡的檔案）
-- 4. 大螢幕的設定改了就立刻生效，不必重新整理
--
-- 前三件的共同背景：彩排一定會留下測試資料。以前只能藏不能刪，
-- 而「藏起來」在測試資料上是錯的做法——它會一直算在人數裡。
--
-- 此檔可重複執行。

-- ============================================================
-- 一、刪掉一位報到者
-- ============================================================
--
-- 圖片留在 Storage 裡不動。刪掉那一列之後任何地方都看不到他，
-- 而檔案本身沒有任何入口找得到（路徑是 uuid）。要連檔案一起清的話
-- 得再開一條 Storage 的刪除政策，那個權限比這裡需要的大得多。
--
-- 抽中過獎的人擋下來不給刪：draws.participant_id 沒有 cascade，
-- 硬刪會撞外鍵，而那個錯誤訊息現場沒有人看得懂。更重要的是
-- 「刪掉一位中獎者」幾乎一定是誤操作。

drop function if exists public.remove_participant(uuid);

create or replace function public.remove_participant(p_participant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.participants;
  v_draws int;
begin
  select * into v_row from public.participants p where p.id = p_participant_id;

  if v_row.id is null then
    raise exception 'PARTICIPANT_NOT_FOUND';
  end if;

  -- 不是自己活動底下的人：一律當成找不到，不透露他存不存在
  if not exists (
    select 1 from public.events e
     where e.id = v_row.event_id and e.host_id = auth.uid()
  ) then
    raise exception 'PARTICIPANT_NOT_FOUND';
  end if;

  select count(*)::int into v_draws
    from public.draws d where d.participant_id = p_participant_id;

  if v_draws > 0 then
    raise exception 'HAS_DRAW';
  end if;

  -- participants_broadcast_change 會處理 DELETE，大螢幕上那一隻立刻消失；
  -- participants_sync_count 會把人數扣回來。兩件事都不必在這裡做。
  delete from public.participants where id = p_participant_id;

  return jsonb_build_object('display_name', v_row.display_name);
end;
$$;

revoke all on function public.remove_participant(uuid) from public;
grant execute on function public.remove_participant(uuid) to authenticated;

-- ============================================================
-- 二、整場清空報到資料
-- ============================================================
--
-- 這是彩排完要做的事，破壞性很大，所以跟刪場次同一套：
-- 要把活動名稱一起送上來對過。
--
-- 抽獎紀錄跟著清掉。留著的話那幾列會指向已經不存在的人，
-- 而「重置報到」本來就等於「這場從頭開始」。

drop function if exists public.reset_participants(uuid, text);

create or replace function public.reset_participants(
  p_event_id uuid,
  p_name     text
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events;
  v_removed int;
begin
  select * into v_event from public.events e where e.id = p_event_id;

  if v_event.id is null then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  if v_event.host_id <> auth.uid() then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  if btrim(coalesce(p_name, '')) <> btrim(v_event.name) then
    raise exception 'NAME_MISMATCH';
  end if;

  select count(*)::int into v_removed
    from public.participants where event_id = p_event_id;

  -- 先清抽獎紀錄：draws.participant_id 沒有 cascade
  delete from public.draws where event_id = p_event_id;
  delete from public.participants where event_id = p_event_id;

  return v_removed;
end;
$$;

revoke all on function public.reset_participants(uuid, text) from public;
grant execute on function public.reset_participants(uuid, text) to authenticated;

-- ============================================================
-- 三、餅乾照片：改署名
-- ============================================================
--
-- 現場會遇到的是「打錯字」與「根本沒填」。照片牆上寫的就是這一欄，
-- 主持人看得到牆、也看得到是誰，補一個名字比請那個人重拍快得多。

drop function if exists public.set_cookie_name(uuid, text);

create or replace function public.set_cookie_name(
  p_cookie_id uuid,
  p_name      text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_clean text;
begin
  select c.event_id into v_event_id from public.cookies c where c.id = p_cookie_id;
  if v_event_id is null then
    raise exception 'COOKIE_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.events e
     where e.id = v_event_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  -- 空字串等於清掉署名，存成 null（跟上傳時沒填是同一個狀態）
  v_clean := nullif(btrim(coalesce(p_name, '')), '');

  if v_clean is not null and char_length(v_clean) > 30 then
    raise exception 'NAME_TOO_LONG';
  end if;

  update public.cookies set display_name = v_clean where id = p_cookie_id;

  perform realtime.send(
    jsonb_build_object('event_id', v_event_id, 'cookie_id', p_cookie_id),
    'cookie:changed', 'event:' || v_event_id, false);
end;
$$;

revoke all on function public.set_cookie_name(uuid, text) from public;
grant execute on function public.set_cookie_name(uuid, text) to authenticated;

-- ============================================================
-- 四、餅乾照片：真的刪掉
-- ============================================================
--
-- C14 刻意只做「隱藏」，理由是「刪了那個人問起就查不到」。那個理由
-- 對真的參與者成立，對彩排時自己拍的測試照片不成立——那幾張會一直
-- 算在「已經有 N 張」裡面，而且打包下載時也會被收進去。
--
-- 回傳 image_path，讓前端接著把 Storage 裡的檔案也刪掉。
-- 不在這裡刪檔案：SQL 端刪 storage.objects 只會拿掉索引那一列，
-- 底層的物件不一定會跟著回收，用 Storage 的 API 才是乾淨的做法。

drop function if exists public.delete_cookie(uuid);

create or replace function public.delete_cookie(p_cookie_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.cookies;
begin
  select * into v_row from public.cookies c where c.id = p_cookie_id;
  if v_row.id is null then
    raise exception 'COOKIE_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.events e
     where e.id = v_row.event_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  delete from public.cookies where id = p_cookie_id;

  perform realtime.send(
    jsonb_build_object('event_id', v_row.event_id, 'cookie_id', p_cookie_id),
    'cookie:changed', 'event:' || v_row.event_id, false);

  return jsonb_build_object('image_path', v_row.image_path);
end;
$$;

revoke all on function public.delete_cookie(uuid) from public;
grant execute on function public.delete_cookie(uuid) to authenticated;

-- 主持人可以刪掉自己活動資料夾底下的餅乾檔案。
-- 路徑的第一段就是 event_id（submit_cookie 強制的），所以這一條政策
-- 精確地只開放「自己那一場」。
drop policy if exists cookies_host_delete_object on storage.objects;
create policy cookies_host_delete_object on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'cookies'
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] in (
      select e.id::text from public.events e where e.host_id = auth.uid())
  );

-- ============================================================
-- 五、大螢幕的設定改了就立刻生效
-- ============================================================
--
-- 設定是後台直接 update events 那一列，大螢幕靠八秒一次的輪詢發現。
-- 切換「餅乾照片牆／流動／關閉」的時候，那八秒（加上餅乾清單自己的
-- 十二秒）長到會讓人以為壞掉，去按重新整理。
--
-- 改成寫入時廣播一則，大螢幕收到就立刻重查一次設定。輪詢留著當保險：
-- 廣播掉了最多還是八秒。
--
-- 只監看真的會改變畫面的那幾欄。subtitle、logo_url 走的是另一條
-- 既有的快照輪詢，不必為它們多發一則。

create or replace function public.broadcast_stage_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform realtime.send(
    jsonb_build_object('event_id', new.id),
    'stage:settings', 'event:' || new.id, false);
  return new;
exception when others then
  -- 廣播失敗絕不能擋下設定的寫入；輪詢會補上
  return new;
end;
$$;

drop trigger if exists events_broadcast_settings on public.events;
create trigger events_broadcast_settings
  after update of stage_config, stage_display, world_template
  on public.events
  for each row execute function public.broadcast_stage_settings();

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
