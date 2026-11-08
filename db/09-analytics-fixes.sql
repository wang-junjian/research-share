-- ===========================================================================
-- 09 · 埋点口径修正（v3）：分享 method 补全、文档型跳转可见、频控丢弃可数
--
-- 执行顺序：01 → 02 → 03 → 04 → … → 08 → 本文件。全部幂等。
--
-- 三件事，对应看板审计发现的三处「不报错但算错」：
--
--   1. track_event 的 method 白名单缺 copy_src。
--      详情页实际有 6 个分享按钮（lib/render.js 的 data-act），其中
--      「复制原文链接」的 data-act 是 copy-src，落库前退化成 copy_src；
--      白名单不认它 → props 被清空 → 事件照落库，但在分享效力表里
--      join 不到任何行。结果：overview.shares（count(*)）含它、明细不含它，
--      总数与 6 行之和永远对不上，而 UI 上看不出异常。
--      本次同时把分享效力表补齐到 6 行，顺序与页面按钮一致。
--
--   2. 文档型成果（kind='doc'）的「查看原文」跳的是本站托管地址
--      （/item/N/doc），assets/track.js 原先只把「跨域」当外链，
--      于是文档型条目的 outbound_click 恒为 0 —— 北极星对这类条目失效，
--      还会被判成「点开不跳转」。本次给 outbound_click 开一个 via 维度
--      （enum: doc），props 白名单同步放行。
--
--   3. 应用层的 IP 频控丢弃原先不落任何计数，看板健康度显示「丢弃 0」。
--      新增 track_drop() 作为低信任通道的对账入口：调用方只能写
--      rate_limit 这一种原因（bad_event / debounce / session_cap 仍由
--      track_event 内部自己记），避免它变成任意写的旁路。
--
-- 另修两处看板口径不一致：
--   · serverPv 排除 /item/N/doc —— 该页按自身 CSP 沙箱不加载 track.js，
--     把它算进覆盖率分母会让「JS 没跑起来」的指标恒定偏低；
--   · versions 面板补 not is_bot 与自己人排除，与其它所有指标同口径。
-- ===========================================================================

-- ---- 1. track_event()：method 白名单补 copy_src、props 白名单补 via ----
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
    if p_props ? 'method' and p_props->>'method' = any(array['copy_link','copy_src','copy_text','show_poster','copy_poster','copy_poster_link']) then v_props := v_props || jsonb_build_object('method', p_props->>'method'); end if;
    if p_props ? 'to' and p_props->>'to' = any(array['grid','list']) then v_props := v_props || jsonb_build_object('to', p_props->>'to'); end if;
    if p_props ? 'view_mode' and p_props->>'view_mode' = any(array['grid','list']) then v_props := v_props || jsonb_build_object('view_mode', p_props->>'view_mode'); end if;
    if p_props ? 'from' and p_props->>'from' = any(array['home','grid','list','direct','share','other']) then v_props := v_props || jsonb_build_object('from', p_props->>'from'); end if;
    if p_props ? 'kind' and p_props->>'kind' = any(array['js','resource','unhandled','api']) then v_props := v_props || jsonb_build_object('kind', p_props->>'kind'); end if;
    if p_props ? 'degrade' and jsonb_typeof(p_props->'degrade') = 'boolean' then v_props := v_props || jsonb_build_object('degrade', p_props->'degrade'); end if;
    if p_props ? 'position' and (p_props->>'position') ~ '^[0-9]{1,3}$' then v_props := v_props || jsonb_build_object('position', (p_props->>'position')::int); end if;
    if p_props ? 'dest_host' then v_props := v_props || jsonb_build_object('dest_host', left(regexp_replace(p_props->>'dest_host', '[^A-Za-z0-9.-]', '', 'g'), 64)); end if;
    if p_props ? 'landing' then v_props := v_props || jsonb_build_object('landing', left(regexp_replace(p_props->>'landing', '[^A-Za-z0-9/_-]', '', 'g'), 64)); end if;
    if p_props ? 'msg' then v_props := v_props || jsonb_build_object('msg', left(p_props->>'msg', 120)); end if;
    if p_props ? 'via' and p_props->>'via' = any(array['doc']) then v_props := v_props || jsonb_build_object('via', p_props->>'via'); end if;
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

-- ---- 2. track_drop()：应用层丢弃计数 ---------------------------------------
-- 与 track_event 同样对 anon 开放（服务端进程就是 anon），所以必须自己
-- 限定原因白名单：不认识的原因静默丢弃，不报错、不暴露字典。
-- n 夹在 1..100000，防止这条通道被当成计数器灌水。
CREATE OR REPLACE FUNCTION public.track_drop(p_reason text, p_n integer DEFAULT 1)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_reason text := lower(coalesce(p_reason, ''));
  v_n int := greatest(1, least(100000, coalesce(p_n, 1)));
  v_day date := (now() at time zone 'Asia/Shanghai')::date;
begin
  if v_reason <> all (array['rate_limit']) then return; end if;
  insert into analytics_drops(day, reason, n) values (v_day, v_reason, v_n)
  on conflict (day, reason) do update set n = analytics_drops.n + excluded.n;
end;
$function$;

-- ---- 3. analytics_dashboard()：分享效力表、覆盖率分母与 versions 口径 ----
CREATE OR REPLACE FUNCTION public.analytics_dashboard(p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_days int := greatest(1, least(365, coalesce(p_days, 30)));
  v_today date := (now() at time zone 'Asia/Shanghai')::date;
  v_from date := (now() at time zone 'Asia/Shanghai')::date - (greatest(1, least(365, coalesce(p_days, 30))) - 1);
  v_t0 timestamptz;
  v_t1 timestamptz;
  v_p0 timestamptz;
  v_excl text[] := '{}';
  v_cur jsonb; v_prev jsonb; v_trend jsonb; v_funnel jsonb; v_items jsonb;
  v_sources jsonb; v_devices jsonb; v_browsers jsonb; v_share jsonb; v_ret jsonb;
  v_recent jsonb; v_hourly jsonb; v_active int := 0; v_health jsonb;
begin
  if not is_admin() then raise exception 'forbidden: 仅管理员可查看数据看板'; end if;
  v_t0 := (v_from::timestamp at time zone 'Asia/Shanghai');
  v_t1 := ((v_today + 1)::timestamp at time zone 'Asia/Shanghai');
  v_p0 := ((v_from - v_days)::timestamp at time zone 'Asia/Shanghai');
  select coalesce(array_agg(visitor_id), '{}') into v_excl from analytics_exclude;

  select jsonb_build_object(
    'visitors', count(distinct e.visitor_id), 'sessions', count(distinct e.session_id),
    'pageviews', count(*) filter (where e.event = 'page_view' and e.source = 'client'),
    'view_item', count(*) filter (where e.event = 'view_item'),
    'outboundClicks', count(*) filter (where e.event = 'outbound_click'),
    'shares', count(*) filter (where e.event = 'share'),
    'outboundRate', round((count(*) filter (where e.event = 'outbound_click'))::numeric / nullif(count(*) filter (where e.event = 'view_item'), 0), 4),
    'events', count(*)
  ) into v_cur
  from research_events e
  where e.occurred_at >= v_t0 and e.occurred_at < v_t1 and not e.is_bot
    and (e.visitor_id is null or e.visitor_id <> all(v_excl));

  select jsonb_build_object(
    'visitors', count(distinct e.visitor_id), 'sessions', count(distinct e.session_id),
    'pageviews', count(*) filter (where e.event = 'page_view' and e.source = 'client'),
    'view_item', count(*) filter (where e.event = 'view_item'),
    'outboundClicks', count(*) filter (where e.event = 'outbound_click'),
    'shares', count(*) filter (where e.event = 'share'),
    'outboundRate', round((count(*) filter (where e.event = 'outbound_click'))::numeric / nullif(count(*) filter (where e.event = 'view_item'), 0), 4),
    'events', count(*)
  ) into v_prev
  from research_events e
  where e.occurred_at >= v_p0 and e.occurred_at < v_t0 and not e.is_bot
    and (e.visitor_id is null or e.visitor_id <> all(v_excl));

  select coalesce(jsonb_agg(jsonb_build_object(
      'd', to_char(g.day, 'MM-DD'),
      'visitors', coalesce(t.v, 0), 'sessions', coalesce(t.s, 0), 'pageviews', coalesce(t.p, 0),
      'view_item', coalesce(t.vi, 0), 'outbound', coalesce(t.o, 0), 'shares', coalesce(t.sh, 0),
      'published', exists (select 1 from research_items ri where ri.item_date = g.day::date)
    ) order by g.day), '[]'::jsonb) into v_trend
  from generate_series(v_from::timestamp, v_today::timestamp, interval '1 day') g(day)
  left join lateral (
    select count(distinct e.visitor_id) v, count(distinct e.session_id) s,
           count(*) filter (where e.event = 'page_view' and e.source = 'client') p,
           count(*) filter (where e.event = 'view_item') vi,
           count(*) filter (where e.event = 'outbound_click') o,
           count(*) filter (where e.event = 'share') sh
    from research_events e
    where (e.occurred_at at time zone 'Asia/Shanghai')::date = g.day::date and not e.is_bot
      and (e.visitor_id is null or e.visitor_id <> all(v_excl))
  ) t on true;

  -- 漏斗必须是「嵌套」的：第 N 级的会话集合 ⊆ 第 N-1 级。
  -- 早先按「各步到达的会话数」并列统计，会出现 7 → 3 → 6 → 3 这种非单调形状，
  -- 「流失」算出来是负数，而 UI 上还标着「最大流失点，优先动这里」——等于给错建议。
  -- 这里用一个按会话聚合的标志位 CTE 把嵌套关系写进数据本身。
  -- 同时单独给出 direct：直接从分享链接落在详情页、没经过首页的会话数。
  -- 它们天然进不了「首页有交互」这条链，必须显式说出来，否则「流失在首页」会被误读。
  select jsonb_build_object(
    'steps', jsonb_build_array(
      jsonb_build_object('label', '会话', 'hint', '30 分钟不活动即切新会话', 'n', count(*)),
      jsonb_build_object('label', '首页有交互', 'hint', '点了卡片', 'n', count(*) filter (where s.interacted)),
      jsonb_build_object('label', '详情页浏览', 'hint', '有交互的会话里点开了详情', 'n', count(*) filter (where s.interacted and s.viewed)),
      jsonb_build_object('label', '原文跳转', 'hint', '一路走到「查看原文」', 'n', count(*) filter (where s.interacted and s.viewed and s.jumped))
    ),
    'direct', count(*) filter (where s.viewed and not s.interacted)
  ) into v_funnel
  from (
    select e.session_id,
           -- v2：change_view_mode 随视图切换功能一并下线，interacted 只计 select_content
           bool_or(e.event = 'select_content') as interacted,
           bool_or(e.event = 'view_item') as viewed,
           bool_or(e.event = 'outbound_click') as jumped
    from research_events e
    where e.occurred_at >= v_t0 and e.occurred_at < v_t1 and not e.is_bot and e.session_id is not null
      and (e.visitor_id is null or e.visitor_id <> all(v_excl))
    group by e.session_id
  ) s;

  select coalesce(jsonb_agg(x order by (x->>'views')::int desc, (x->>'id')::int), '[]'::jsonb) into v_items from (
    select jsonb_build_object(
      'id', ri.id, 'title', ri.title, 'exposed', (min(ri.item_date) < v_from),
      'views', count(*) filter (where e.event = 'view_item'),
      'outbound', count(*) filter (where e.event = 'outbound_click'),
      'shares', count(*) filter (where e.event = 'share'),
      'last', to_char((max(e.occurred_at) filter (where e.event <> 'content_publish')) at time zone 'Asia/Shanghai', 'MM-DD HH24:MI')
    ) as x
    from research_items ri
    left join research_events e on e.item_id = ri.id and e.occurred_at >= v_t0 and e.occurred_at < v_t1
      and not e.is_bot and (e.visitor_id is null or e.visitor_id <> all(v_excl))
    group by ri.id, ri.title
  ) q;

  select coalesce(jsonb_agg(jsonb_build_object('label', k.label, 'n', coalesce(c.n, 0)) order by coalesce(c.n, 0) desc, k.ord), '[]'::jsonb) into v_sources
  from (values (1,'直接访问','direct'),(2,'知乎','zhihu'),(3,'站内跳转','internal'),(4,'搜索引擎','search'),(5,'微信','wechat'),(6,'其他','other')) k(ord, label, kind)
  left join (
    select s.kind, count(*) n from (
      -- 归因规则：会话里最早一条**带 ref_kind** 的事件决定来源。
      -- 必须显式写出 tie-break —— session_start 与 page_view 常常落在同一时刻，
      -- 只按 occurred_at 排序时，谁抢到「该会话第一条」是随机的，
      -- 于是同一批数据两次查询会给出不同的来源分布（实测踩到过）。
      select distinct on (e.session_id) coalesce(e.ref_kind, 'other') kind
      from research_events e
      where e.occurred_at >= v_t0 and e.occurred_at < v_t1 and not e.is_bot and e.session_id is not null
        and (e.visitor_id is null or e.visitor_id <> all(v_excl))
      order by e.session_id, (e.ref_kind is null), e.occurred_at, e.id
    ) s group by s.kind
  ) c on c.kind = k.kind;

  select jsonb_build_array(
    jsonb_build_object('label', '手机', 'n', count(distinct e.session_id) filter (where e.device = 'mobile')),
    jsonb_build_object('label', '桌面', 'n', count(distinct e.session_id) filter (where e.device = 'desktop')),
    jsonb_build_object('label', '平板', 'n', count(distinct e.session_id) filter (where e.device = 'tablet'))
  ) into v_devices
  from research_events e
  where e.occurred_at >= v_t0 and e.occurred_at < v_t1 and not e.is_bot
    and (e.visitor_id is null or e.visitor_id <> all(v_excl));

  select coalesce(jsonb_agg(jsonb_build_object('label', t.b, 'n', t.n) order by t.n desc), '[]'::jsonb) into v_browsers
  from (select coalesce(e.browser, '未知') b, count(distinct e.session_id) n
        from research_events e
        -- session_id is not null：这一格数的是「会话」，服务端那条不带会话的 page_view 只能贡献 0。
        -- 不排除的话会多出一行「XXX 0%」的图例（浏览器有值、会话数为 0）。
        where e.occurred_at >= v_t0 and e.occurred_at < v_t1 and not e.is_bot and e.session_id is not null
          and (e.visitor_id is null or e.visitor_id <> all(v_excl))
        group by 1 order by 2 desc limit 6) t;

  select coalesce(jsonb_agg(jsonb_build_object('label', k.label, 'method', k.method, 'n', coalesce(c.n, 0), 'degrade', coalesce(c.dg, 0)) order by coalesce(c.n, 0) desc, k.ord), '[]'::jsonb) into v_share
  from (values (1,'copy_poster','复制海报图'),(2,'show_poster','显示海报图'),(3,'copy_src','复制原文链接'),(4,'copy_link','复制本页链接'),(5,'copy_poster_link','复制海报图+原文链接'),(6,'copy_text','复制文字+原文链接')) k(ord, method, label)
  left join (
    select e.props->>'method' m, count(*) n, count(*) filter (where e.props->>'degrade' = 'true') dg
    from research_events e
    where e.event = 'share' and e.occurred_at >= v_t0 and e.occurred_at < v_t1 and not e.is_bot
      and (e.visitor_id is null or e.visitor_id <> all(v_excl))
    group by 1
  ) c on c.m = k.method;

  with fv as (
    select e.visitor_id, min((e.occurred_at at time zone 'Asia/Shanghai')::date) first_d
    from research_events e
    where e.visitor_id is not null and not e.is_bot and e.visitor_id <> all(v_excl)
    group by 1
  ), act as (
    select distinct e.visitor_id, (e.occurred_at at time zone 'Asia/Shanghai')::date d
    from research_events e
    where e.visitor_id is not null and e.occurred_at >= v_t0 and e.occurred_at < v_t1 and not e.is_bot and e.visitor_id <> all(v_excl)
  ), wk as (
    select date_trunc('week', a.d)::date w, count(distinct a.visitor_id) tot,
           count(distinct a.visitor_id) filter (where f.first_d < date_trunc('week', a.d)::date) ret
    from act a join fv f using (visitor_id) group by 1
  )
  select jsonb_build_object(
    'new', (select count(distinct a.visitor_id) from act a join fv f using (visitor_id) where f.first_d >= v_from),
    'returning', (select count(distinct a.visitor_id) from act a join fv f using (visitor_id) where f.first_d < v_from),
    'weekly', (select coalesce(jsonb_agg(jsonb_build_object('label', to_char(w, 'MM-DD'), 'total', tot, 'returning', ret, 'rate', case when tot > 0 then round(ret::numeric / tot, 4) else 0 end) order by w), '[]'::jsonb) from wk)
  ) into v_ret;

  select coalesce(jsonb_agg(jsonb_build_object('t', to_char(e.occurred_at at time zone 'Asia/Shanghai', 'HH24:MI'), 'event', e.event, 'no', e.item_id, 'props', e.props, 'device', e.device, 'kind', e.ref_kind) order by e.occurred_at desc), '[]'::jsonb) into v_recent
  from (select * from research_events e where not e.is_bot and (e.visitor_id is null or e.visitor_id <> all(v_excl)) order by e.occurred_at desc limit 20) e;

  select count(distinct e.visitor_id) into v_active
  from research_events e
  where e.occurred_at > now() - interval '30 minutes' and not e.is_bot
    and (e.visitor_id is null or e.visitor_id <> all(v_excl));

  select coalesce(jsonb_agg(coalesce(t.n, 0) order by h.h), '[]'::jsonb) into v_hourly
  from generate_series(0, 23) h(h)
  left join (
    select extract(hour from (e.occurred_at at time zone 'Asia/Shanghai'))::int hr, count(distinct e.visitor_id) n
    from research_events e
    where (e.occurred_at at time zone 'Asia/Shanghai')::date = v_today and not e.is_bot
      and (e.visitor_id is null or e.visitor_id <> all(v_excl))
    group by 1
  ) t on t.hr = h.h;

  select jsonb_build_object(
    'clientPv', count(*) filter (where e.event = 'page_view' and e.source = 'client' and not e.is_bot),
    'serverPv', count(*) filter (where e.event = 'page_view' and e.source = 'server' and not e.is_bot and coalesce(e.page, '') not like '%/doc'),
    'totalEvents', count(*), 'botEvents', count(*) filter (where e.is_bot),
    'drops', coalesce((select jsonb_object_agg(d.reason, d.n) from analytics_drops d where d.day >= v_from and d.day <= v_today), '{}'::jsonb),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('label', v.v, 'n', v.n) order by v.n desc) from (select e2.app_version v, count(*) n from research_events e2
             where e2.occurred_at >= v_t0 and e2.occurred_at < v_t1 and not e2.is_bot
               and (e2.visitor_id is null or e2.visitor_id <> all(v_excl)) group by 1) v), '[]'::jsonb)
  ) into v_health
  from research_events e
  where e.occurred_at >= v_t0 and e.occurred_at < v_t1
    and (e.visitor_id is null or e.visitor_id <> all(v_excl));

  return jsonb_build_object(
    'range', jsonb_build_object('days', v_days, 'from', v_from, 'to', v_today),
    'overview', v_cur, 'prev', v_prev, 'trend', v_trend, 'funnel', v_funnel, 'items', v_items,
    'sources', v_sources, 'devices', v_devices, 'browsers', v_browsers, 'share', v_share,
    'retention', v_ret, 'recent', v_recent, 'hourly', v_hourly, 'activeNow', v_active, 'health', v_health
  );
end;
$function$;


-- ---- 4. 权限 ---------------------------------------------------------------
-- 与 db/03 第 7 节、db/08 同口径：平台会给新函数自动补 anon/authenticated/
-- service_role 的 EXECUTE，只 REVOKE FROM PUBLIC 不够，必须逐角色点名。

revoke all on function public.track_event(text, text, text, bigint, text, text, text, text, text, text, jsonb, text, text, boolean, text) from public;
revoke all on function public.track_event(text, text, text, bigint, text, text, text, text, text, text, jsonb, text, text, boolean, text) from authenticated, service_role;
grant execute on function public.track_event(text, text, text, bigint, text, text, text, text, text, text, jsonb, text, text, boolean, text) to anon;

revoke all on function public.track_drop(text, integer) from public;
revoke all on function public.track_drop(text, integer) from authenticated, service_role;
grant execute on function public.track_drop(text, integer) to anon;

revoke all on function public.analytics_dashboard(integer) from public, anon;
grant execute on function public.analytics_dashboard(integer) to authenticated;

-- 执行完请复查，期望：track_event 只有一个 15 参版本、anon 只出现在
-- track_event 与 track_drop 上，analytics_dashboard 的 anon 已被收回：
--   select p.proname, p.pronargs, p.proacl from pg_proc p
--   where p.pronamespace = 'public'::regnamespace
--     and p.proname in ('track_event','track_drop','analytics_dashboard');
