-- ===========================================================================
-- 05 · 初始管理员：任命权收归独占
--
-- 背景：01 里 admins 表的 INSERT/DELETE 策略只判 is_admin() —— 任何管理员都
-- 能任命或移除管理员，被任命者可以先下手移除任命人。本迁移引入「初始管理员
-- （Founder Admin）」：全站唯一、不可经正常途径删除，独占 admins 名单的增删。
-- 普通管理员对成果与看板的管理能力不变（is_admin() 语义不动）。
-- 决策记录见 docs/adr/0003-founder-admin-exclusive-appoint.md。
--
-- 幂等：重复执行不会报错，也不会改动已有归属。
-- ===========================================================================

-- ---- 1. admins 加 is_founder 列 ----------------------------------------------
alter table public.admins add column if not exists is_founder boolean not null default false;

-- 全站唯一：部分唯一索引，至多一行为 true（第二个 founder 会在索引层被拒绝）
create unique index if not exists admins_founder_uidx
  on public.admins (is_founder) where is_founder;

-- ---- 2. is_founder() ----------------------------------------------------------
-- 与 is_admin() 同款：单点判定、SECURITY DEFINER 绕过 admins 自身的 RLS、
-- 不做缓存，撤销即时生效。必须定义在 policy 之前。
create or replace function public.is_founder()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (select 1 from admins where user_id = auth.uid() and is_founder)
$function$;

revoke all on function public.is_founder() from public;
grant execute on function public.is_founder() to authenticated;

-- ---- 3. 任命权收窄：admins 的增删只有初始管理员能做 ----------------------------
drop policy if exists admins_insert_admin on public.admins;
drop policy if exists admins_insert_founder on public.admins;
create policy admins_insert_founder on public.admins
  for insert to authenticated with check (is_founder());

drop policy if exists admins_delete_admin on public.admins;
drop policy if exists admins_delete_founder on public.admins;
-- 追加 not is_founder：founder 行不可经正常途径删除，含 founder 本人（防手滑）。
-- 交接是罕见操作，走一次性手工 SQL 直接改 is_founder 标记（见 README）。
create policy admins_delete_founder on public.admins
  for delete to authenticated using (is_founder() and not is_founder);

-- ---- 4. 种子：初始管理员 --------------------------------------------------------
-- 「初始只有我是管理者」从此可复现。此 user_id 与 db/02 中 agent 写入的归属一致。
-- on conflict 兜底：行已存在则只补 is_founder 标记，不动 added_at。
-- 注意：clone 本仓库自建部署时，把这里的 user_id 换成你自己的（登录一次后台可见）。
insert into public.admins (user_id, is_founder)
values ('wb:vRfYGtPaA3PGlcSwC0YJEK3CCmsP', true)
on conflict (user_id) do update set is_founder = true;
