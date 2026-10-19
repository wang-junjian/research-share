-- ===========================================================================
-- 06 · 文档型成果：research_items 增加 kind / doc_html 两列
--
-- 背景：成果原先只有「链接型」（标题 + 概览 + 站外原文链接）。文档型成果把
-- 一份自包含 HTML 文档托管在本站（托管地址 /item/:id/doc 即其原文链接，
-- 不落库），术语见 GLOSSARY.md，隔离决策见 docs/adr/0004。
--
-- 本迁移两部分：
--   §1-§3 结构地基：两列 + CHECK 强约束 + url 放宽可空，存量数据零回填
--   （默认 'link'）。RLS 策略不变——新列随行走 01 的现有策略。
--   §4-§5 写入语义：agent_upsert_item 升级接受 doc_html（携带即文档型），
--   同 source_key 幂等重投只更新标元、永不覆盖 doc_html（内容不可变，
--   docs/adr/0004）；agent_upsert_items 同步透传。
--
-- 幂等：重复执行不会报错，也不会改动已有数据。
-- 发布顺序：先执行本迁移，再部署依赖新列与新签名的代码。注意 §4 会 DROP 旧的
-- 6 参 agent_upsert_item（加参即换签名，CREATE OR REPLACE 覆盖不了），迁移与
-- 部署之间的窗口内旧代码的写调用会失败——窗口以秒计，写完即恢复。
-- ===========================================================================

-- ---- 1. 两列：kind 与 doc_html ------------------------------------------------
-- kind：正文形态，'link'（站外链接）或 'doc'（本站托管文档）。
-- doc_html：文档原文（自包含 HTML），仅文档型有值；大文本走 TOAST，不进列表查询。
alter table public.research_items add column if not exists kind text not null default 'link';
alter table public.research_items add column if not exists doc_html text;

-- ---- 2. url 放宽为可空 ---------------------------------------------------------
-- 文档型没有站外原文链接（原文链接即派生托管地址，不落库），url 必须随之可空。
-- 链接型的「url 必填」改由下面的 CHECK 表达，约束强度不变。
alter table public.research_items alter column url drop not null;

-- ---- 3. CHECK 强约束 -----------------------------------------------------------
-- 形态与字段的配套关系在库层钉死，任何写入路径（浏览器直写 / RPC）都绕不过：
--   · kind 取值合法；
--   · 链接型 url 必填；文档型 doc_html 必填且 url 为空；
--   · doc_html ≤ 1MB（按字符数，与应用层预检口径一致）。
alter table public.research_items drop constraint if exists research_items_kind_check;
alter table public.research_items add constraint research_items_kind_check
  check (kind in ('link', 'doc'));

alter table public.research_items drop constraint if exists research_items_shape_check;
alter table public.research_items add constraint research_items_shape_check
  check (
    (kind = 'link' and url is not null)
    or (kind = 'doc' and doc_html is not null and url is null)
  );

alter table public.research_items drop constraint if exists research_items_doc_html_size_check;
alter table public.research_items add constraint research_items_doc_html_size_check
  check (doc_html is null or char_length(doc_html) <= 1000000);

-- ---- 4. agent_upsert_item 升级：接受 doc_html，重投不覆盖文档内容 ----------------
-- 形态判定在库内单点完成：携带非空 doc_html 即文档型，否则链接型（不暴露 kind
-- 参数，避免 kind 与 doc_html 自相矛盾的组合）。幂等语义（Spec #2）：同
-- source_key 重投只更新标元（标题/概览/日期/写入者），链接型维持旧契约 url 随
-- 重投更新；文档型的 doc_html 一经写入永不覆盖（内容不可变，docs/adr/0004）。
-- 边缘情形：已有行与重投形态不一致时，行的 kind 与内容列都保持原样，只动标元。
--
-- 加参即换签名（PostgreSQL 重载），CREATE OR REPLACE 覆盖不了旧签名，先 DROP；
-- 旧签名的授权随 DROP 消失，权限在 §5 对新签名重新收敛。
drop function if exists public.agent_upsert_item(text, text, text, text, date, text);

create or replace function public.agent_upsert_item(
  p_token text, p_title text, p_summary text, p_url text,
  p_date date default null, p_source_key text default null,
  p_doc_html text default null
) returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_agent text; v_id bigint; v_action text; v_key text;
  v_kind text; v_existing_kind text;
begin
  v_agent := agent_check_token(p_token);

  -- 携带非空 doc_html 即文档型（GLOSSARY: 文档型成果），否则链接型
  v_kind := case when p_doc_html is not null and btrim(p_doc_html) <> '' then 'doc' else 'link' end;

  if p_title   is null or btrim(p_title)   = '' then raise exception 'missing_field: title'   using errcode='22023'; end if;
  if p_summary is null or btrim(p_summary) = '' then raise exception 'missing_field: summary' using errcode='22023'; end if;
  if char_length(p_title)   > 300 then raise exception 'field_too_long: title (max 300)'   using errcode='22001'; end if;
  if char_length(p_summary) > 400 then raise exception 'field_too_long: summary (max 400)' using errcode='22001'; end if;

  if v_kind = 'link' then
    if p_url is null or btrim(p_url) = '' then raise exception 'missing_field: url' using errcode='22023'; end if;
    if char_length(p_url) > 2000 then raise exception 'field_too_long: url (max 2000)' using errcode='22001'; end if;
  else
    -- 文档型没有站外原文链接（原文链接即派生托管地址，不落库）
    if p_url is not null and btrim(p_url) <> '' then
      raise exception 'invalid_field: url (文档型成果不接受 url)' using errcode='22023';
    end if;
    if char_length(p_doc_html) > 1000000 then
      raise exception 'field_too_long: doc_html (max 1000000 chars)' using errcode='22001';
    end if;
  end if;

  v_key := nullif(btrim(coalesce(p_source_key, '')), '');
  if v_key is not null then
    select id, kind into v_id, v_existing_kind from research_items where source_key = v_key;
  end if;

  if v_id is null then
    -- owner_id 服务端写死，调用方无法伪造归属
    insert into research_items (title, summary, url, kind, doc_html, item_date, owner_name, owner_id, source_key, source_agent)
    values (btrim(p_title), btrim(p_summary),
            case when v_kind = 'link' then btrim(p_url) end,
            v_kind,
            case when v_kind = 'doc' then p_doc_html end,
            coalesce(p_date, current_date),
            '军舰', 'wb:vRfYGtPaA3PGlcSwC0YJEK3CCmsP', v_key, v_agent)
    returning id into v_id;
    v_action := 'created';
  else
    -- 幂等重投只更新标元：doc_html 永不覆盖；url 仅当行与重投同为链接型时更新
    -- （文档行的 url 必须保持 null，否则顶破 §3 的 CHECK）
    update research_items set
      title = btrim(p_title), summary = btrim(p_summary),
      url = case when v_kind = 'link' and v_existing_kind = 'link' then btrim(p_url) else url end,
      item_date = coalesce(p_date, item_date), source_agent = v_agent, updated_at = now()
     where id = v_id;
    v_action := 'updated';
  end if;

  return jsonb_build_object('ok', true, 'action', v_action, 'id', v_id);
end; $fn$;

-- 批量：签名未变（text, jsonb），create or replace 保留既有授权；仅同步传参列表
create or replace function public.agent_upsert_items(p_token text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare v_agent text; v_item jsonb; v_res jsonb; v_out jsonb := '[]'::jsonb; v_c int := 0; v_u int := 0;
begin
  v_agent := agent_check_token(p_token);
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_field: items (must be a JSON array)' using errcode='22023'; end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'invalid_field: items (empty array)' using errcode='22023'; end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'invalid_field: items (max 500 per call)' using errcode='22023'; end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_res := agent_upsert_item(p_token, v_item->>'title', v_item->>'summary', v_item->>'url',
                               nullif(btrim(coalesce(v_item->>'date','')), '')::date,
                               v_item->>'source_key', v_item->>'doc_html');
    if v_res->>'action' = 'created' then v_c := v_c + 1; else v_u := v_u + 1; end if;
    v_out := v_out || jsonb_build_array(v_res);
  end loop;

  return jsonb_build_object('ok', true, 'created', v_c, 'updated', v_u, 'total', v_c + v_u, 'items', v_out);
end; $fn$;

-- ---- 5. 权限收敛（新签名，按 db/02 同款范式） ----------------------------------
-- 平台会给新建函数自动补 anon/authenticated/service_role 的 EXECUTE，点名收回后
-- 只把写入口开给 anon —— 服务端进程就是这个身份。
revoke all on function public.agent_upsert_item(text, text, text, text, date, text, text) from public;
revoke all on function public.agent_upsert_item(text, text, text, text, date, text, text) from anon, authenticated, service_role;
grant execute on function public.agent_upsert_item(text, text, text, text, date, text, text) to anon;

-- 批量签名未变、授权随 create or replace 保留，此处幂等重申，不依赖平台行为
revoke all on function public.agent_upsert_items(text, jsonb) from public;
revoke all on function public.agent_upsert_items(text, jsonb) from anon, authenticated, service_role;
grant execute on function public.agent_upsert_items(text, jsonb) to anon;
