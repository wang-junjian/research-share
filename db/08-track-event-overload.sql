-- ===========================================================================
-- 08 · 收掉 track_event 的旧签名重载 + 补上 db/04 欠的权限收敛
--
-- 背景：db/04 给 track_event 加 p_app_version 时用了 CREATE OR REPLACE，
-- 但「加参即换签名」——CREATE OR REPLACE 覆盖不了旧签名，只是并存为重载
-- （db/06 总结过这个教训，db/04 写在前，没来得及修）。结果库里同时挂着
-- 14 参（db/03，不认识 app_version）与 15 参（db/04）两个 track_event：
--
--   - 14 参旧版还带着 db/03 授予的 anon EXECUTE，写入口不再唯一——
--     日后再改白名单/频控/鉴权逻辑时，旧版是一个没人记得的旁路；
--   - ver 缺失/非法时服务端只传 14 个具名参数，两个重载都匹配这次调用，
--     rpc 网关的重载解析可能判歧义报错，或路由到不含版本处理的旧版，
--     app_version 维度被静默污染；
--   - db/04 对新版没做任何 revoke/grant，平台自动补的
--     anon/authenticated/service_role EXECUTE 至今挂着。
--
-- 本迁移：
--   1. DROP 14 参旧重载。应用两条调用路径（SSR page_view、POST /api/track）
--      都用具名参数，14 参调用会自动解析到 15 参新版（第 15 参有默认值），
--      应用代码零改动。唯一会报错的是绕过应用、按旧签名手工直调的人——
--      执行前可用文末的复查 SQL 确认现状。
--   2. 对 15 参新版重申权限，按 db/03 第 7 节同口径点名收回。
--
-- 幂等：DROP IF EXISTS 与 REVOKE/GRANT 重复执行均无副作用。
-- ===========================================================================

-- 1. 旧签名重载（db/03 的 14 参版）
drop function if exists public.track_event(text, text, text, bigint, text, text, text, text, text, text, jsonb, text, text, boolean);

-- 2. 15 参新版的权限收敛（与 db/03 第 7 节同口径）
revoke all on function public.track_event(text, text, text, bigint, text, text, text, text, text, text, jsonb, text, text, boolean, text) from public;
revoke all on function public.track_event(text, text, text, bigint, text, text, text, text, text, text, jsonb, text, text, boolean, text) from authenticated, service_role;

-- 埋点必须匿名可调（公开页面上的访客没有登录态）
grant execute on function public.track_event(text, text, text, bigint, text, text, text, text, text, text, jsonb, text, text, boolean, text) to anon;

-- 执行完请复查，期望只剩一个 track_event（pronargs = 15）、且 anon 只在它身上：
--   select p.proname, p.pronargs, p.proacl from pg_proc p
--   where p.pronamespace = 'public'::regnamespace
--     and p.proname in ('track_event','analytics_dashboard');
