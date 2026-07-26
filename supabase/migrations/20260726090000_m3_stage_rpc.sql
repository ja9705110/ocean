-- M3：大螢幕的全量角色查詢
--
-- participants 對 anon 完全關閉 select（M1 決策），大螢幕在 M6 導入
-- 主持人登入之前，先以此 RPC 取得初始渲染所需的全量資料。
-- 只回傳「本來就會投影在大螢幕上」的欄位，不含 device_token，
-- 且只回傳 is_visible 的角色（主持人隱藏後大螢幕自然拿不到）。
--
-- 此檔可獨立重複執行（create or replace），不影響既有資料。

create or replace function public.get_stage_participants(p_event_id uuid)
returns table (
  id uuid,
  display_name text,
  character_name text,
  image_path text,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.display_name, p.character_name, p.image_path, p.joined_at
    from public.participants p
   where p.event_id = p_event_id
     and p.is_visible
   order by p.joined_at;
$$;

revoke execute on function public.get_stage_participants(uuid) from public;
grant execute on function public.get_stage_participants(uuid) to anon, authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
-- 少了這一行，新建立的函式要等快取自然過期才會生效，
-- 前端會收到「找不到函式 ...（schema cache）」。
notify pgrst, 'reload schema';
