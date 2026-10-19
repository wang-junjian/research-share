-- ===========================================================================
-- 07 · 漏斗 interacted 口径收窄（埋点口径 v2）
--
-- 背景：视图切换功能已移除，change_view_mode 事件自 v2 起前端不再发送
-- （assets/track.js VERSION v1 → v2），select_content 也不再带 view_mode。
-- 但 db/03 的 analytics_dashboard() 仍把 change_view_mode 计入「首页有交互」，
-- 历史会话里的该事件会抬高旧数据的 interacted，与 v2 数据混在一起不可比。
--
-- 本迁移只改 funnel 一节的两行（见函数内「v2」注释），其余与 db/03 原样一致：
--   1. interacted 只计 select_content；
--   2. 「首页有交互」的 hint 去掉「或切换视图」。
-- 历史 change_view_mode 事件保留在 research_events 里不删（可回溯）；
-- track_event 白名单也仍接受它——缓存页面可能还在发，收下比报错好。
--
-- 幂等：CREATE OR REPLACE 同签名覆盖；权限语句重复执行无副作用。
-- ===========================================================================

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
  from (values (1,'copy_link','复制本页链接'),(2,'copy_text','复制文字+原文链接'),(3,'show_poster','显示海报图'),(4,'copy_poster','复制海报图'),(5,'copy_poster_link','复制海报图+原文链接')) k(ord, method, label)
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
    'serverPv', count(*) filter (where e.event = 'page_view' and e.source = 'server' and not e.is_bot),
    'totalEvents', count(*), 'botEvents', count(*) filter (where e.is_bot),
    'drops', coalesce((select jsonb_object_agg(d.reason, d.n) from analytics_drops d where d.day >= v_from and d.day <= v_today), '{}'::jsonb),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('label', v.v, 'n', v.n) order by v.n desc) from (select e2.app_version v, count(*) n from research_events e2 where e2.occurred_at >= v_t0 and e2.occurred_at < v_t1 group by 1) v), '[]'::jsonb)
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
$function$

-- 权限重申（CREATE OR REPLACE 保留既有授权，这里重复执行无副作用，
-- 与 db/03 第 7 节同：防止有人按本平台「自动补 EXECUTE」的特性重建过函数）
revoke all on function public.analytics_dashboard(integer) from public, anon;
grant execute on function public.analytics_dashboard(integer) to authenticated;
