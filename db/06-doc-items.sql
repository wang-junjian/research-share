-- ===========================================================================
-- 06 · 文档型成果：research_items 增加 kind / doc_html 两列
--
-- 背景：成果原先只有「链接型」（标题 + 概览 + 站外原文链接）。文档型成果把
-- 一份自包含 HTML 文档托管在本站（托管地址 /item/:id/doc 即其原文链接，
-- 不落库），术语见 GLOSSARY.md，隔离决策见 docs/adr/0004。
--
-- 本迁移只做结构地基：两列 + CHECK 强约束 + url 放宽可空，存量数据零回填
-- （默认 'link'）。RLS 策略不变——新列随行走 01 的现有策略。
-- agent_upsert_item 等 RPC 的 doc_html 幂等语义由后续迁移在同一文件追加
-- （CREATE OR REPLACE 幂等），本期保持现有 RPC 签名与行为不变。
--
-- 幂等：重复执行不会报错，也不会改动已有数据。
-- 发布顺序：先执行本迁移，再部署依赖新列的代码。
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
