-- ===========================================================================
-- 研究成果 · Agent 接口 · 数据库迁移存档
-- 在 01-research-items.sql 之后执行
--
-- 背景：应用服务端进程是 anon 身份（只有 publishableKey、无登录会话），
--       而 anon 在 research_items 上只有 SELECT —— 直连表写不进去。
--       也不该把 INSERT 授权给 anon：publishableKey 明文写在 server.js 里，
--       那等于把写权限公开。
--
-- 方案：写权限锁在 SECURITY DEFINER 函数里，函数内先校验 token 再落库。
--       token 只存 SHA-256。表与函数都不给 anon 开权限，只开 EXECUTE。
--
-- 注意：PostgreSQL 17，sha256(bytea) 是内建函数，不需要 pgcrypto。
--       平台会给新建函数自动补 anon/authenticated/service_role 的 EXECUTE，
--       所以 REVOKE ... FROM PUBLIC 不够，必须点名 revoke。
-- ===========================================================================

-- ---- 1. research_items 扩展：幂等键、写入者、更新时间 -----------------------
ALTER TABLE public.research_items
  ADD COLUMN IF NOT EXISTS source_key   text,
  ADD COLUMN IF NOT EXISTS source_agent text,
  ADD COLUMN IF NOT EXISTS updated_at   timestamptz;

-- 部分唯一索引：只有带 source_key 的行参与唯一性，人工录入的 NULL 不冲突
CREATE UNIQUE INDEX IF NOT EXISTS research_items_source_key_uidx
  ON public.research_items (source_key) WHERE source_key IS NOT NULL;

-- ---- 2. token 表：单向哈希存储，谁都没有读权限 -----------------------------
CREATE TABLE IF NOT EXISTS public.agent_tokens (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  token_hash   text NOT NULL UNIQUE,
  enabled      boolean NOT NULL DEFAULT true,
  expires_at   timestamptz,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

ALTER TABLE public.agent_tokens ENABLE ROW LEVEL SECURITY;
-- 无 policy + 无 grant ⇒ 除了表 owner 谁都不行
REVOKE ALL PRIVILEGES ON TABLE public.agent_tokens FROM anon, authenticated;

-- ---- 3. 内部 token 校验器（只给函数内部用，不对外开 EXECUTE） --------------
CREATE OR REPLACE FUNCTION public.agent_check_token(p_token text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_name text;
BEGIN
  IF p_token IS NULL OR length(p_token) < 16 THEN
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '28000';
  END IF;
  SELECT t.name INTO v_name FROM agent_tokens t
   WHERE t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
     AND t.enabled
     AND (t.expires_at IS NULL OR t.expires_at > now());
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '28000';
  END IF;
  UPDATE agent_tokens SET last_used_at = now()
   WHERE token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  RETURN v_name;
END; $fn$;

-- ---- 4. 唯一写入口：upsert（按 source_key 判存在） -------------------------
CREATE OR REPLACE FUNCTION public.agent_upsert_item(
  p_token text, p_title text, p_summary text, p_url text,
  p_date date DEFAULT NULL, p_source_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_agent text; v_id bigint; v_action text; v_key text;
BEGIN
  v_agent := agent_check_token(p_token);

  IF p_title   IS NULL OR btrim(p_title)   = '' THEN RAISE EXCEPTION 'missing_field: title'   USING ERRCODE='22023'; END IF;
  IF p_summary IS NULL OR btrim(p_summary) = '' THEN RAISE EXCEPTION 'missing_field: summary' USING ERRCODE='22023'; END IF;
  IF p_url     IS NULL OR btrim(p_url)     = '' THEN RAISE EXCEPTION 'missing_field: url'     USING ERRCODE='22023'; END IF;
  IF length(p_title)   > 300  THEN RAISE EXCEPTION 'field_too_long: title (max 300)'     USING ERRCODE='22001'; END IF;
  IF length(p_summary) > 400  THEN RAISE EXCEPTION 'field_too_long: summary (max 400)'   USING ERRCODE='22001'; END IF;
  IF length(p_url)     > 2000 THEN RAISE EXCEPTION 'field_too_long: url (max 2000)'      USING ERRCODE='22001'; END IF;

  v_key := NULLIF(btrim(coalesce(p_source_key, '')), '');
  IF v_key IS NOT NULL THEN
    SELECT id INTO v_id FROM research_items WHERE source_key = v_key;
  END IF;

  IF v_id IS NULL THEN
    -- owner_id 服务端写死，调用方无法伪造归属
    INSERT INTO research_items (title, summary, url, item_date, owner_name, owner_id, source_key, source_agent)
    VALUES (btrim(p_title), btrim(p_summary), btrim(p_url), COALESCE(p_date, CURRENT_DATE),
            '军舰', 'wb:vRfYGtPaA3PGlcSwC0YJEK3CCmsP', v_key, v_agent)
    RETURNING id INTO v_id;
    v_action := 'created';
  ELSE
    UPDATE research_items SET
      title = btrim(p_title), summary = btrim(p_summary), url = btrim(p_url),
      item_date = COALESCE(p_date, item_date), source_agent = v_agent, updated_at = now()
     WHERE id = v_id;
    v_action := 'updated';
  END IF;

  RETURN jsonb_build_object('ok', true, 'action', v_action, 'id', v_id);
END; $fn$;

-- ---- 5. 局部更新（只改传了的字段） ----------------------------------------
CREATE OR REPLACE FUNCTION public.agent_patch_item(
  p_token text, p_id bigint,
  p_title text DEFAULT NULL, p_summary text DEFAULT NULL,
  p_url text DEFAULT NULL, p_date date DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_agent text; v_n int;
BEGIN
  v_agent := agent_check_token(p_token);
  IF p_id IS NULL THEN RAISE EXCEPTION 'missing_field: id' USING ERRCODE='22023'; END IF;
  IF p_title   IS NOT NULL AND (btrim(p_title)   = '' OR length(p_title)   > 300)  THEN RAISE EXCEPTION 'invalid_field: title (1-300)'   USING ERRCODE='22023'; END IF;
  IF p_summary IS NOT NULL AND (btrim(p_summary) = '' OR length(p_summary) > 400)  THEN RAISE EXCEPTION 'invalid_field: summary (1-400)' USING ERRCODE='22023'; END IF;
  IF p_url     IS NOT NULL AND (btrim(p_url)     = '' OR length(p_url)     > 2000) THEN RAISE EXCEPTION 'invalid_field: url (1-2000)'     USING ERRCODE='22023'; END IF;

  UPDATE research_items SET
    title      = COALESCE(NULLIF(btrim(p_title),   ''), title),
    summary    = COALESCE(NULLIF(btrim(p_summary), ''), summary),
    url        = COALESCE(NULLIF(btrim(p_url),     ''), url),
    item_date  = COALESCE(p_date, item_date),
    source_agent = v_agent,
    updated_at = now()
   WHERE id = p_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'item_not_found: %', p_id USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('ok', true, 'action', 'updated', 'id', p_id);
END; $fn$;

-- ---- 6. 删除 ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_delete_item(p_token text, p_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_agent text; v_n int; v_title text;
BEGIN
  v_agent := agent_check_token(p_token);
  IF p_id IS NULL THEN RAISE EXCEPTION 'missing_field: id' USING ERRCODE='22023'; END IF;
  DELETE FROM research_items WHERE id = p_id RETURNING title INTO v_title;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'item_not_found: %', p_id USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('ok', true, 'action', 'deleted', 'id', p_id, 'title', v_title);
END; $fn$;

-- ---- 7. 批量 upsert（单事务，天然原子） ------------------------------------
CREATE OR REPLACE FUNCTION public.agent_upsert_items(p_token text, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_agent text; v_item jsonb; v_res jsonb; v_out jsonb := '[]'::jsonb; v_c int := 0; v_u int := 0;
BEGIN
  v_agent := agent_check_token(p_token);
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid_field: items (must be a JSON array)' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'invalid_field: items (empty array)' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_items) > 500 THEN
    RAISE EXCEPTION 'invalid_field: items (max 500 per call)' USING ERRCODE='22023'; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_res := agent_upsert_item(p_token, v_item->>'title', v_item->>'summary', v_item->>'url',
                               NULLIF(btrim(coalesce(v_item->>'date','')), '')::date,
                               v_item->>'source_key');
    IF v_res->>'action' = 'created' THEN v_c := v_c + 1; ELSE v_u := v_u + 1; END IF;
    v_out := v_out || jsonb_build_array(v_res);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'created', v_c, 'updated', v_u, 'total', v_c + v_u, 'items', v_out);
END; $fn$;

-- ---- 8. 权限收敛 -----------------------------------------------------------
-- REVOKE FROM PUBLIC 只删掉 PUBLIC 那一项；平台建函数时自动补的显式授权要另外收回
REVOKE ALL ON FUNCTION
  public.agent_check_token(text),
  public.agent_upsert_item(text,text,text,text,date,text),
  public.agent_patch_item(text,bigint,text,text,text,date),
  public.agent_delete_item(text,bigint),
  public.agent_upsert_items(text,jsonb)
  FROM PUBLIC;

REVOKE ALL ON FUNCTION public.agent_check_token(text) FROM anon, authenticated, service_role;

-- 只把这 4 个写入口开给 anon —— 服务端进程就是这个身份
GRANT EXECUTE ON FUNCTION
  public.agent_upsert_item(text,text,text,text,date,text),
  public.agent_patch_item(text,bigint,text,text,text,date),
  public.agent_delete_item(text,bigint),
  public.agent_upsert_items(text,jsonb)
  TO anon;

-- ---- 9. 首个 token（只存 SHA-256，原文不落库） -----------------------------
--
-- 这一步**需要你自己做**，本文件不预置任何 token。
--
-- 生成与登记：
--   TOKEN="rsa_$(openssl rand -hex 16)"
--   printf '%s' "$TOKEN" > .agent-token          # 留在本机，别提交
--   HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
--
--   INSERT INTO public.agent_tokens (name, token_hash, note)
--   VALUES ('main-agent', '<上面算出的 HASH>', '首个 agent 令牌');
--
-- 之后所有写接口带 `X-Agent-Token: $TOKEN` 即可。校验逻辑见 agent_check_token()。
-- 撤销一个 token 不用改任何代码：UPDATE agent_tokens SET enabled = false WHERE name = '...';
