-- ===========================================================================
-- 01 · 基础表：内容与管理员
--
-- 执行顺序：01 → 02 → 03 → 04 → 05 → 06 → 07 → 08。所有文件都是幂等的（IF NOT EXISTS / CREATE OR REPLACE），
-- 重复执行不会报错，也不会清空已有数据。
--
-- 角色说明（与云服务的 RLS 模型对应）：
--   anon          未登录访客，也就是「公开页面」的身份
--   authenticated 已登录用户，也就是「后台管理」的身份
-- ===========================================================================

-- ---- 1. 内容表 -------------------------------------------------------------
create table if not exists public.research_items (
  id            bigint generated always as identity primary key,
  title         text        not null,
  summary       text        not null,
  url           text        not null,
  item_date     date        not null default current_date,
  created_at    timestamptz not null default now(),
  owner_name    text,
  owner_id      text        default auth.uid(),
  -- 幂等键：同一个 source_key 重复写入只会更新，不会新增。
  -- 用 agent / 同步脚本批量导入时，靠它把「跑第二遍」变成安全的操作。
  source_key    text,
  source_agent  text,
  updated_at    timestamptz
);

-- 幂等键必须唯一，但允许多行为 NULL（手工在后台新增的条目就没有 source_key）
create unique index if not exists research_items_source_key_uidx
  on public.research_items (source_key) where source_key is not null;

-- ---- 2. 管理员表 -----------------------------------------------------------
-- 只存 user_id。管理员身份不做缓存，每次都由 is_admin() 现查，
-- 这样撤销权限是即时生效的。
create table if not exists public.admins (
  user_id  text primary key,
  added_at timestamptz not null default now()
);

-- ---- 3. is_admin() ---------------------------------------------------------
-- 必须定义在 policy 之前：policy 的表达式在创建时就会校验函数是否存在。
--
-- 单点鉴权：全站所有「是不是管理员」的判断都走这个函数。
-- SECURITY DEFINER 用来绕过 admins 表自身的 RLS（否则在 RLS 里再查 RLS 会递归）。
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (select 1 from admins where user_id = auth.uid())
$function$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ---- 4. 行级安全（RLS）-----------------------------------------------------
alter table public.research_items enable row level security;
alter table public.admins enable row level security;

-- 公开页面要能被任何人读 —— 这是这个应用唯一对匿名开放的直接读权限
drop policy if exists research_items_read_all on public.research_items;
create policy research_items_read_all on public.research_items
  for select to anon, authenticated using (true);

-- 写操作只给登录用户，且只能改自己的；管理员可以改任何人的
drop policy if exists ri_insert_authenticated on public.research_items;
create policy ri_insert_authenticated on public.research_items
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists ri_update_own_or_admin on public.research_items;
create policy ri_update_own_or_admin on public.research_items
  for update to authenticated
  using ((owner_id = auth.uid()) or is_admin())
  with check ((owner_id = auth.uid()) or is_admin());

drop policy if exists ri_delete_own_or_admin on public.research_items;
create policy ri_delete_own_or_admin on public.research_items
  for delete to authenticated
  using ((owner_id = auth.uid()) or is_admin());

-- 管理员名单对登录用户可读（后台要展示），改动只允许管理员做
drop policy if exists admins_read on public.admins;
create policy admins_read on public.admins
  for select to authenticated using (true);

drop policy if exists admins_insert_admin on public.admins;
create policy admins_insert_admin on public.admins
  for insert to authenticated with check (is_admin());

drop policy if exists admins_delete_admin on public.admins;
create policy admins_delete_admin on public.admins
  for delete to authenticated using (is_admin());

-- ---- 5. 表级授权 -----------------------------------------------------------
-- 注意：RLS 策略与 GRANT 是两道独立的门，两道都要开才放行。
grant select on public.research_items to anon;
grant select, insert, update, delete on public.research_items to authenticated;
grant select, insert, delete on public.admins to authenticated;

-- ---- 6. 种子 ----------------------------------------------------------------
-- 本文件不再 seed 管理员：db/05 引入「初始管理员」后会把自己的 user_id 直接
-- 写进 admins 并标 is_founder = true，任命权（admins 的增删）也同步收窄到
-- 初始管理员。要加第一个管理员，去执行 db/05（自建部署先换成自己的 user_id）。
