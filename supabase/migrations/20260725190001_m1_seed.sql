-- M1：種子活動
-- 建立一場開放中的示範活動，供 M2（手機端）與 M3（大螢幕）開發測試使用。
-- host_id 先留空，M6 建立主持人登入後再指派。

insert into public.events (code, name, subtitle, world_template, draw_count, status)
values ('DEMO01', '示範活動', '海洋世界測試場', 'ocean', 3, 'open')
on conflict (code) do nothing;
