-- C32：主持人的餅乾照片清單
--
-- 到目前為止，餅乾照片上傳完就只活在大螢幕上。活動結束之後：
--
--   * 沒有任何地方看得到全部的照片
--   * set_cookie_visible 這支函式從 C14 就存在，但沒有介面呼叫它——
--     現場真的拍到桌面、拍到人臉的那一兩張，主持人藏不掉
--   * 照片存不下來。那是大家自己畫的東西，活動結束該給得回去。
--
-- list_cookies（給大螢幕的那一支）只回傳看得見的，而且不含 is_visible，
-- 所以後台沒辦法用它——後台要看到「被藏起來的那幾張」，
-- 不然按了隱藏之後那張就從畫面上消失，再也叫不回來。
--
-- 沒有另外做刪除。藏起來就夠了：刪掉之後那個人問「我的呢」就查不到了，
-- 而現場一定會有人問。
--
-- 此檔可重複執行。

drop function if exists public.list_cookies_admin(uuid);

create or replace function public.list_cookies_admin(p_event_id uuid)
returns table (
  id           uuid,
  image_path   text,
  display_name text,
  is_visible   boolean,
  created_at   timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select c.id, c.image_path, c.display_name, c.is_visible, c.created_at
    from public.cookies c
   where c.event_id = p_event_id
     -- 只有自己的活動。不是的話回傳空集合，而不是報錯——
     -- 報錯等於告訴對方「這場活動存在」。
     and exists (
       select 1 from public.events e
        where e.id = c.event_id and e.host_id = auth.uid())
   -- 上傳順序：跟大螢幕上的排列一致，主持人講「左上角第三張」對得起來
   order by c.created_at, c.id
$$;

revoke execute on function public.list_cookies_admin(uuid) from public;
grant execute on function public.list_cookies_admin(uuid) to authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
