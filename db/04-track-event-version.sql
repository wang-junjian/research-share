-- 04：track_event() 接入口径版本（app_version）
--
-- 背景：客户端埋点一直在发 ver（assets/track.js，「改口径必须递增」），
-- research_events.app_version 列也早就有（03），但 track_event() 没有这个
-- 参数 —— 链路断在中间，看板 versions 维度永远只有默认值 'v1'。
-- 本迁移给函数加 p_app_version（默认 'v1'，旧调用方不用改），格式校验
-- 失败按 'v1' 落库，不让脏值进维度。

CREATE OR REPLACE FUNCTION public.track_event(p_event text, p_visitor text DEFAULT NULL::text, p_session text DEFAULT NULL::text, p_item bigint DEFAULT NULL::bigint, p_page text DEFAULT NULL::text, p_referrer text DEFAULT NULL::text, p_ref_kind text DEFAULT NULL::text, p_device text DEFAULT NULL::text, p_os text DEFAULT NULL::text, p_browser text DEFAULT NULL::text, p_props jsonb DEFAULT '{}'::jsonb, p_source text DEFAULT 'client'::text, p_ip_hash text DEFAULT NULL::text, p_is_bot boolean DEFAULT false, p_app_version text DEFAULT 'v1'::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_event text := lower(coalesce(p_event, ''));
  v_props jsonb := '{}'::jsonb;
  v_item bigint := null;
  v_visitor text := null;
  v_session text := null;
  v_kind text;
  v_version text := 'v1';
  v_day date := (now() at time zone 'Asia/Shanghai')::date;
  v_cnt int;
begin
  if v_event <> all (array['session_start','page_view','view_item','select_content','change_view_mode','outbound_click','share','error','content_publish']) then
    insert into analytics_drops(day, reason, n) values (v_day, 'bad_event', 1) on conflict (day, reason) do update set n = analytics_drops.n + 1;
    return 'dropped:bad_event';
  end if;
  if p_visitor ~ '^[A-Za-z0-9_-]{8,64}$' then v_visitor := p_visitor; end if;
  if p_session ~ '^[A-Za-z0-9_-]{8,64}$' then v_session := p_session; end if;
  if p_app_version ~ '^v[0-9]{1,8}$' then v_version := p_app_version; end if;
  if p_props is not null and jsonb_typeof(p_props) = 'object' then
    if p_props ? 'method' and p_props->>'method' = any(array['copy_link','copy_text','show_poster','copy_poster','copy_poster_link']) then v_props := v_props || jsonb_build_object('method', p_props->>'method'); end if;
    if p_props ? 'to' and p_props->>'to' = any(array['grid','list']) then v_props := v_props || jsonb_build_object('to', p_props->>'to'); end if;
    if p_props ? 'view_mode' and p_props->>'view_mode' = any(array['grid','list']) then v_props := v_props || jsonb_build_object('view_mode', p_props->>'view_mode'); end if;
    if p_props ? 'from' and p_props->>'from' = any(array['home','grid','list','direct','share','other']) then v_props := v_props || jsonb_build_object('from', p_props->>'from'); end if;
    if p_props ? 'kind' and p_props->>'kind' = any(array['js','resource','unhandled','api']) then v_props := v_props || jsonb_build_object('kind', p_props->>'kind'); end if;
    if p_props ? 'degrade' and jsonb_typeof(p_props->'degrade') = 'boolean' then v_props := v_props || jsonb_build_object('degrade', p_props->'degrade'); end if;
    if p_props ? 'position' and (p_props->>'position') ~ '^[0-9]{1,3}$' then v_props := v_props || jsonb_build_object('position', (p_props->>'position')::int); end if;
    if p_props ? 'dest_host' then v_props := v_props || jsonb_build_object('dest_host', left(regexp_replace(p_props->>'dest_host', '[^A-Za-z0-9.-]', '', 'g'), 64)); end if;
    if p_props ? 'landing' then v_props := v_props || jsonb_build_object('landing', left(regexp_replace(p_props->>'landing', '[^A-Za-z0-9/_-]', '', 'g'), 64)); end if;
    if p_props ? 'msg' then v_props := v_props || jsonb_build_object('msg', left(p_props->>'msg', 120)); end if;
    if p_props ? 'q' then v_props := v_props || jsonb_build_object('q', left(p_props->>'q', 60)); end if;
  end if;
  if p_item is not null then select id into v_item from research_items where id = p_item; end if;
  if v_session is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_session || '|' || v_event || '|' || coalesce(v_item, 0)::text || '|' || v_props::text, 0));
    select count(*) into v_cnt from research_events e where e.session_id = v_session;
    if v_cnt >= 500 then
      insert into analytics_drops(day, reason, n) values (v_day, 'session_cap', 1) on conflict (day, reason) do update set n = analytics_drops.n + 1;
      return 'dropped:session_cap';
    end if;
    if exists (select 1 from research_events e where e.session_id = v_session and e.event = v_event and coalesce(e.item_id, 0) = coalesce(v_item, 0) and e.props = v_props and e.occurred_at > now() - interval '3 seconds') then
      insert into analytics_drops(day, reason, n) values (v_day, 'debounce', 1) on conflict (day, reason) do update set n = analytics_drops.n + 1;
      return 'dropped:debounce';
    end if;
  end if;
  if p_ref_kind = any(array['wechat','zhihu','search','internal','direct','other']) then v_kind := p_ref_kind; else v_kind := 'other'; end if;
  insert into research_events (event, source, visitor_id, session_id, item_id, page, referrer, ref_kind, device, os, browser, is_bot, ip_hash, props, app_version)
  values (v_event, case when p_source = 'server' then 'server' else 'client' end, v_visitor, v_session, v_item, left(p_page, 120), left(p_referrer, 200), v_kind, left(p_device, 12), left(p_os, 32), left(p_browser, 32), coalesce(p_is_bot, false), left(p_ip_hash, 32), v_props, v_version);
  return 'ok';
end;
$function$;
