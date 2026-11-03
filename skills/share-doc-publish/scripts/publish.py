#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""publish.py —— 把一份本地文档连做两跳：资料库公开页 → 研究成果站。

    ┌ 第 1 跳：资料库 ────────────────────────────────────┐
    │ import_html.py  上传 → 生成「页面」节点                │
    │ publish_page.py 发布 → https://workbuddy.link/p/<id> │ ← 任何人不登录可看
    └──────────────────────────────┬──────────────────────┘
                                   │ node_id 当幂等键
    ┌ 第 2 跳：研究成果站 ──────────▼──────────────────────┐
    │ POST /api/items → 列表卡片 + 详情页 + 专属分享封面      │
    └─────────────────────────────────────────────────────┘

用法：
    python3 scripts/publish.py scan <file>                      # 体检
    python3 scripts/publish.py meta --title … --summary …        # 只数标题/摘要字数
    python3 scripts/publish.py library <file> [--space-id S]    # 只做第 1 跳
    python3 scripts/publish.py site --title … --summary … --url …   # 只做第 2 跳
    python3 scripts/publish.py all <file> --title … --summary …  # 两跳 + 验收
    python3 scripts/publish.py verify <item_id>                 # 只验收

关键约定（都是踩出来的，别改）：

- 认证头是 `X-Agent-Token`。`Authorization: Bearer` 会被平台边缘代理吃掉，线上 401。
- 幂等键用 `library:<node_id>`：同一份文档重跑只更新，不新增卡片。
- 链接型条目的 url 带 `?source=2`：与站内既有 58 条一致，是分发来源标记。
- 文档型（--mode doc）不接受 url，原文链接由站点派生为 /item/<id>/doc。
- 验收不看返回码：health 条数、详情页 200、封面图字节数、列表页标题，四样都要对。
- **title ≤300、summary ≤400，字数按 UTF-16 码元算**（同 JS `s.length`），
  且在**上传前**校验——两跳不是事务，别让第 2 跳的 400 白建一个资料库页面。
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

# 平台内置的 library 技能：两跳里的第 1 跳靠它，不重写上传协议
LIBRARY_CANDIDATES = [
    os.environ.get("LIBRARY_SKILL_DIR", ""),
    "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked"
    "/resources/plugins/workbuddy-builtin/skills/library",
]
LIBRARY_GLOB = (
    "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked"
    "/resources/plugins/**/skills/library"
)

DEFAULT_SITE = "https://research-share.app.workbuddy.host"

# 站点接口的字段上限，与 server.js `pickText(..., {max})` 一致：
# title 300、summary 400（`lib/agent-api.js` 的 pickUpsertFields）。
# 为什么写死在这里：两跳**不是事务**。第 1 跳一执行就在资料库真建了一个页面，
# 第 2 跳再因超长被 400，那个页面就白建了（2026-11-03 踩过：summary 403 字）。
# 所以字数必须在**上传前**拦——见 cmd_all 里的 preflight。
TITLE_MAX = 300
SUMMARY_MAX = 400


def utf16_len(s: str) -> int:
    """按服务端口径数字数：JS 的 `s.length` 是 UTF-16 码元数。

    中文、西文各算 1，BMP 以外（emoji、部分符号）算 2 —— Python 的 `len()`
    会把这些算 1，用它当口径就会「本地看着没超、服务端 400」。
    """
    return len(s.encode("utf-16-le")) // 2


def check_meta(title: str, summary: str) -> list[str]:
    """校验标题与摘要的长度。返回问题列表，空列表即通过。

    只做长度与必填，不管文风——但「别照抄资料库 og 描述」这类内容要求写在 SKILL.md。
    """
    problems: list[str] = []
    t, s = (title or "").strip(), (summary or "").strip()
    n_t, n_s = utf16_len(t), utf16_len(s)

    if not t:
        problems.append("title 为空")
    elif n_t > TITLE_MAX:
        problems.append(f"title {n_t} 字，超上限 {n_t - TITLE_MAX} 字（上限 {TITLE_MAX}）")

    if not s:
        problems.append("summary 为空")
    elif n_s > SUMMARY_MAX:
        problems.append(f"summary {n_s} 字，超上限 {n_s - SUMMARY_MAX} 字（上限 {SUMMARY_MAX}）")

    return problems


def meta_stats(title: str, summary: str) -> dict:
    """字数用量，写进报告和 --dry-run 输出，方便一眼看出还剩多少余量。"""
    t, s = (title or "").strip(), (summary or "").strip()
    return {
        "title_len": utf16_len(t),
        "title_max": TITLE_MAX,
        "title_left": TITLE_MAX - utf16_len(t),
        "summary_len": utf16_len(s),
        "summary_max": SUMMARY_MAX,
        "summary_left": SUMMARY_MAX - utf16_len(s),
    }


# --------------------------------------------------------------------------
# 环境探测
# --------------------------------------------------------------------------

def find_library_skill() -> str | None:
    """定位 library 技能目录（第 1 跳的脚本住在那里）。"""
    for c in LIBRARY_CANDIDATES:
        if c and os.path.isfile(os.path.join(c, "page", "import_html.py")):
            return c
    for c in glob.glob(LIBRARY_GLOB, recursive=True):
        if os.path.isfile(os.path.join(c, "page", "import_html.py")):
            return c
    return None


def find_project(explicit: str | None) -> str | None:
    """定位研究成果站项目（读它的 .env 与 .agent-token）。"""
    cands = [explicit, os.getcwd(), os.path.expanduser("~/GitHub/wang-junjian/research-share")]
    cands += glob.glob(os.path.expanduser("~/GitHub/*/research-share"))
    for c in cands:
        if c and os.path.isfile(os.path.join(c, "server.js")):
            return os.path.abspath(c)
    return None


def read_env_file(path: str) -> dict:
    out: dict = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def http_json(method: str, url: str, body: dict | None = None,
              headers: dict | None = None, timeout: float = 30.0) -> tuple[int, dict]:
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", errors="replace")
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, {"raw": raw[:400]}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            # WAF 拦截页是 HTML，不是本站 JSON：这个分支专门用来把它说清楚
            return e.code, {"raw": raw[:400], "waf_suspect": "<html" in raw.lower()}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"error": str(e)}


def http_status(url: str, timeout: float = 20.0) -> tuple[int, int]:
    """返回 (状态码, 字节数)。用于验收封面图与原文链接。"""
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, len(r.read())
    except urllib.error.HTTPError as e:
        return e.code, 0
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, 0


# --------------------------------------------------------------------------
# 第 1 跳：资料库
# --------------------------------------------------------------------------

def run_library_script(lib: str, script: str, args: list[str]) -> tuple[str, str]:
    cmd = [sys.executable, os.path.join(lib, script)] + args
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    return p.stdout or "", p.stderr or ""


def stage_library(file_path: str, *, file_name: str = "", space_id: str = "",
                  parent_id: str = "", node_block_id: str = "") -> dict:
    """上传 + 发布，返回 node_id 与公开链接。"""
    lib = find_library_skill()
    if not lib:
        return {"ok": False, "error": "找不到 library 技能目录（设 LIBRARY_SKILL_DIR 指过去）"}

    args = [os.path.abspath(file_path)]
    if file_name:
        args += ["--file-name", file_name]
    if space_id:
        args += ["--space-id", space_id]
    if parent_id:
        args += ["--parent-id", parent_id]
    if node_block_id:
        args += ["--node-block-id", node_block_id]

    out, err = run_library_script(lib, "page/import_html.py", args)
    m = re.search(r"KS_IMPORT_OK\s+(\{.*\})", out)
    if not m:
        # 脚本失败时也是 exit 0，只在 stdout 吐 {"error": …}
        try:
            e = json.loads(out.strip().splitlines()[-1]) if out.strip() else {}
        except json.JSONDecodeError:
            e = {}
        return {"ok": False, "stage": "import", "error": e.get("error") or (out.strip() or err.strip())[:300]}

    imp = json.loads(m.group(1))
    node_id = imp.get("node_block_id") or ""
    publish_url = imp.get("publish_url") or ""
    edit_url = imp.get("url") or ""

    # 没拿到公开链接就显式发布一次。node id 若对不上，退回 url 里的 /space/d/<id>
    if not publish_url:
        tried = [node_id]
        m2 = re.search(r"/space/d/([A-Za-z0-9]+)", edit_url)
        if m2 and m2.group(1) not in tried:
            tried.append(m2.group(1))
        for nid in [t for t in tried if t]:
            pout, _perr = run_library_script(lib, "page/publish_page.py", ["--node-id", nid])
            pm = re.search(r"KS_PAGE_PUBLISH\s+(\S+)", pout)
            if pm:
                publish_url = pm.group(1).strip()
                node_id = nid
                break

    return {
        "ok": bool(publish_url),
        "stage": "library",
        "node_id": node_id,
        "edit_url": edit_url or (f"https://www.workbuddy.cn/space/d/{node_id}" if node_id else ""),
        "publish_url": publish_url,
        "file_name": imp.get("file_name", ""),
    }


# --------------------------------------------------------------------------
# 第 2 跳：研究成果站
# --------------------------------------------------------------------------

def stage_site(*, title: str, summary: str, url: str = "", doc_html: str = "",
               date: str = "", source_key: str = "", project: str | None = None,
               site: str = "", token: str = "", dry_run: bool = False) -> dict:
    proj = find_project(project)
    env = read_env_file(os.path.join(proj, ".env")) if proj else {}
    site_url = (site or env.get("SITE_URL") or DEFAULT_SITE).rstrip("/")

    tok = token or os.environ.get("RESEARCH_AGENT_TOKEN", "")
    if not tok and proj:
        try:
            tok = open(os.path.join(proj, ".agent-token"), encoding="utf-8").read().strip()
        except OSError:
            tok = ""

    payload: dict = {"title": title.strip(), "summary": summary.strip()}
    if doc_html:
        payload["doc_html"] = doc_html           # 文档型：不带 url
    else:
        payload["url"] = url.strip()
    if date:
        payload["date"] = date
    if source_key:
        payload["source_key"] = source_key

    # 本地先按接口同口径拦一遍：别把 400 留给服务端，来回一趟更费事
    problems = check_meta(payload["title"], payload["summary"])
    if not doc_html and not payload.get("url"):
        problems.append("链接型必须有 url")
    if problems:
        return {"ok": False, "stage": "site", "error": "；".join(problems),
                "meta": meta_stats(payload["title"], payload["summary"])}

    if dry_run:
        peek = dict(payload)
        if "doc_html" in peek:
            peek["doc_html"] = f"<{len(doc_html)} 字符，未发送>"
        return {"ok": True, "stage": "site", "dry_run": True, "site": site_url,
                "would_post": peek, "has_token": bool(tok),
                "meta": meta_stats(payload["title"], payload["summary"])}

    if not tok:
        return {"ok": False, "stage": "site", "error": "没有 agent token（--token 或项目 .agent-token）"}

    before, _ = http_json("GET", f"{site_url}/api/health")
    count_before = before.get("count") if isinstance(before, dict) else None

    status, resp = http_json("POST", f"{site_url}/api/items", payload,
                             headers={"X-Agent-Token": tok})
    # 新建返回 201、幂等更新返回 200 —— 两个都是成功，别只认 200
    if status not in (200, 201) or not resp.get("ok"):
        hint = ""
        if isinstance(resp, dict) and resp.get("waf_suspect"):
            hint = "（返回的是 HTML 拦截页 → 命中了边缘 WAF，检查 doc_html 是否含 <script / on*=）"
        elif status == 401:
            hint = "（401：确认用的是 X-Agent-Token，不是 Authorization: Bearer）"
        return {"ok": False, "stage": "site", "status": status,
                "error": f"{resp.get('error') or resp.get('message') or '写入失败'}{hint}"}

    item = resp.get("item") or {}
    return {
        "ok": True,
        "stage": "site",
        "action": resp.get("action"),
        "id": resp.get("id"),
        "no": item.get("no"),
        "page_url": item.get("page_url"),
        "og_image": item.get("og_image"),
        "item_url": item.get("url"),
        "count_before": count_before,
        "site": site_url,
    }


def http_head_ok(url: str, timeout: float = 20.0) -> tuple[int, dict, int]:
    """返回 (状态码, 响应头, 字节数)。文档型要额外确认 CSP sandbox 头在不在。"""
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return r.status, dict(r.headers), len(body)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), 0
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, {}, 0


def http_text(url: str, timeout: float = 20.0, limit: int = 400_000) -> tuple[int, str]:
    """抓正文文本，用于核对「这个链接上到底还有没有那份文档」。"""
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(limit).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, ""


def stage_verify(item_id: int, *, project: str | None = None, site: str = "") -> dict:
    """四样都验：条数、详情页、封面图字节、列表页标题。文档型另验托管路由与 CSP 头。"""
    proj = find_project(project)
    env = read_env_file(os.path.join(proj, ".env")) if proj else {}
    site_url = (site or env.get("SITE_URL") or DEFAULT_SITE).rstrip("/")

    _, health = http_json("GET", f"{site_url}/api/health")
    _, item = http_json("GET", f"{site_url}/api/items/{item_id}")
    detail_status, detail_bytes = http_status(f"{site_url}/item/{item_id}")
    og_status, og_bytes = http_status(f"{site_url}/og/{item_id}.png")

    listed = False
    try:
        with urllib.request.urlopen(f"{site_url}/", timeout=20) as r:
            html = r.read(2_000_000).decode("utf-8", errors="replace")
            title = (item.get("item") or item).get("title") if isinstance(item, dict) else ""
            listed = bool(title) and title in html
    except (urllib.error.URLError, TimeoutError, OSError):
        pass

    checks = {
        "detail_200": detail_status == 200,
        "og_200": og_status == 200 and og_bytes > 2000,
        "listed_on_home": listed,
    }
    it_obj = (item.get("item") or item) if isinstance(item, dict) else {}

    # 文档型：托管路由必须直出原文，且带 CSP sandbox（ADR-0004 的隔离就靠这一个头）。
    # 注意**不能**用条目的 kind 字段判断 —— Agent API 的白名单里根本没有 kind，
    # 只能靠路由本身：文档型 /item/N/doc 是 200，链接型是 404。
    doc_info = None
    d_status, d_headers, d_bytes = http_head_ok(f"{site_url}/item/{item_id}/doc")
    if d_status == 200:
        csp = d_headers.get("Content-Security-Policy") or d_headers.get("content-security-policy") or ""
        doc_info = {"status": d_status, "bytes": d_bytes, "csp": csp}
        checks["doc_route_200"] = d_bytes > 500
        checks["doc_csp_sandbox"] = "sandbox" in csp
    else:
        doc_info = {"status": d_status, "note": "链接型：无托管原文，/doc 返回 404 是正常的"}

    # 链接型：卡片指向的资料库公开页**还活着吗**。
    # 状态码骗人：页面取消发布后 workbuddy.link 仍返回 200，只是换成 5957 字节的
    # 通用壳页（<title>WorkBuddy</title>、body 空）。判据只能是页面标题——
    # 而且**不能拿条目标题去比**：条目标题是按 h1 改写的，公开页的 <title> 是文档原标题。
    link = (it_obj.get("url") or "") if isinstance(it_obj, dict) else ""
    link_info = None
    if "workbuddy.link" in link:
        l_status, l_body = http_text(link)
        m = re.search(r"<title[^>]*>(.*?)</title>", l_body, re.I | re.S)
        page_title = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1))).strip() if m else ""
        shell = page_title.strip().lower() in ("", "workbuddy", "workbuddy.cn")
        live = l_status == 200 and not shell
        link_info = {"status": l_status, "page_title": page_title, "bytes": len(l_body)}
        checks["source_link_live"] = live
        if l_status == 200 and shell:
            link_info["note"] = "返回 200 但页面标题是通用壳页：大概率已取消发布，正文已不可见"

    return {
        "ok": all(checks.values()),
        "stage": "verify",
        "site": site_url,
        "count": health.get("count") if isinstance(health, dict) else None,
        "detail": {"status": detail_status, "bytes": detail_bytes},
        "og": {"status": og_status, "bytes": og_bytes},
        "doc": doc_info,
        "source_link": link_info,
        "checks": checks,
    }


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def load_doc_html(path: str) -> tuple[str, dict]:
    """文档型要的是「干净静态 HTML」：现场清理，不依赖人记得先跑 sanitize。"""
    text = open(path, encoding="utf-8").read()
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from sanitize import sanitize, verify  # noqa: E402

    clean, stats = sanitize(text)
    v = verify(clean)
    clean_ok = all(v[k] == 0 for k in ("script", "inline_event", "js_uri", "iframe", "editor"))
    return clean, {"stats": stats, "verify": v, "clean": clean_ok}


def cmd_all(args) -> int:
    from precheck import check  # noqa: E402

    pre = check(args.file)
    report: dict = {"file": args.file, "precheck": pre}

    if pre["verdict"] == "blocked":
        print(json.dumps({**report, "ok": False, "error": "体检未通过，未发布"}, ensure_ascii=False, indent=2))
        return 1

    # 标题/摘要的字数必须在**上传前**定下来（见 TITLE_MAX 处的说明）。这里用的
    # title 就是后面真正发给站点的那一个，所以兜底链要和「人会给什么」一致：
    # --title > 文档 h1（SKILL.md 推荐的卡片句式）> <title> > 文件名。
    # 不用资料库改写后的语义名当兜底——那要等第 1 跳跑完才知道，没法前置校验。
    title = (args.title or "").strip()
    if not title:
        title = re.sub(r"\s+", " ", pre.get("h1") or pre.get("title") or "").strip()
    if not title:
        title = os.path.splitext(os.path.basename(args.file))[0]

    meta_problems = check_meta(title, args.summary)
    report["meta"] = meta_stats(title, args.summary)
    report["meta"]["title_source"] = "arg" if args.title else "h1/title/filename"
    if meta_problems:
        hint = "" if args.title else "（当前标题自动取自文档标题，可用 --title 显式指定一个更短的）"
        print(json.dumps({
            **report, "ok": False,
            "error": "标题/摘要不合规，未上传（资料库没有被建页面）："
                     + "；".join(meta_problems) + hint,
        }, ensure_ascii=False, indent=2))
        return 1

    if args.mode == "doc" and pre["verdict"] == "needs_sanitize":
        doc, sinfo = load_doc_html(args.file)
        report["sanitize"] = sinfo
        if not sinfo["clean"]:
            print(json.dumps({**report, "ok": False, "error": "清理后仍有红线残留"}, ensure_ascii=False, indent=2))
            return 1
        doc_path = os.path.join(tempfile.gettempdir(), "doc_publish_clean.html")
        with open(doc_path, "w", encoding="utf-8") as f:
            f.write(doc)
    elif args.mode == "doc":
        doc_path = args.file
    else:
        doc_path = ""

    # dry-run 不上传：第 1 跳一旦执行就会在资料库里真建一个页面
    if args.dry_run:
        lib = {"ok": True, "stage": "library", "dry_run": True,
               "note": "dry-run 未上传、未发布", "node_id": "", "publish_url": ""}
    else:
        lib = stage_library(args.file, file_name=args.file_name, space_id=args.space_id,
                            parent_id=args.parent_id, node_block_id=args.node_block_id)
    report["library"] = lib
    if not lib["ok"] and not args.allow_unpublished:
        print(json.dumps({**report, "ok": False,
                          "error": "第 1 跳失败（资料库未拿到公开链接）"}, ensure_ascii=False, indent=2))
        return 1

    doc_html = ""
    if args.mode == "doc":
        doc_html = open(doc_path, encoding="utf-8").read()

    site = stage_site(
        title=title,
        summary=args.summary,
        url="" if args.mode == "doc" else (lib.get("publish_url", "") + "?source=2"),
        doc_html=doc_html,
        date=args.date,
        source_key=args.source_key or (f"library:{lib.get('node_id')}" if lib.get("node_id") else ""),
        project=args.project, site=args.site, token=args.token, dry_run=args.dry_run,
    )
    report["site"] = site
    if not site["ok"]:
        print(json.dumps({**report, "ok": False, "error": site.get("error")}, ensure_ascii=False, indent=2))
        return 1

    if not args.dry_run:
        report["verify"] = stage_verify(site["id"], project=args.project, site=args.site)

    report["ok"] = bool(report.get("verify", {}).get("ok", True))
    print(json.dumps(report, ensure_ascii=False, indent=2))

    # 人看的那几行：把「该发哪个链接」直接讲明白
    if not args.dry_run:
        print("\n—— 结果 ——")
        m = report["meta"]
        print(f"字数          标题 {m['title_len']}/{m['title_max']} · "
              f"摘要 {m['summary_len']}/{m['summary_max']}")
        print(f"资料库公开页  {lib.get('publish_url')}")
        print(f"编辑（需登录）{lib.get('edit_url')}")
        print(f"站点详情页    {site.get('page_url')}   {site.get('no')}")
        print(f"分享封面      {site.get('og_image')}")
        print(f"验收          {json.dumps(report.get('verify', {}).get('checks', {}), ensure_ascii=False)}")
        print("\n分享请发站点详情页：workbuddy.link 的 og:image 是通用图标、og:description 是固定文案，"
              "微信卡片会很敷衍；站点详情页才有专属封面与真实摘要。")
    return 0 if report["ok"] else 1


def main() -> None:
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("stage", nargs="?", default="")
    ap.add_argument("file", nargs="?", default="")
    ap.add_argument("--title", default="")
    ap.add_argument("--summary", default="")
    ap.add_argument("--url", default="")
    ap.add_argument("--date", default="")
    ap.add_argument("--source-key", dest="source_key", default="")
    ap.add_argument("--mode", choices=["link", "doc"], default="link")
    ap.add_argument("--file-name", dest="file_name", default="")
    ap.add_argument("--space-id", dest="space_id", default="")
    ap.add_argument("--parent-id", dest="parent_id", default="")
    ap.add_argument("--node-block-id", dest="node_block_id", default="")
    ap.add_argument("--project", default="")
    ap.add_argument("--site", default="")
    ap.add_argument("--token", default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-unpublished", action="store_true")
    args, _ = ap.parse_known_args()

    if args.stage == "scan":
        from precheck import check
        print(json.dumps(check(args.file), ensure_ascii=False, indent=2))
        return
    if args.stage == "library":
        print(json.dumps(stage_library(args.file, file_name=args.file_name, space_id=args.space_id,
                                       parent_id=args.parent_id, node_block_id=args.node_block_id),
                         ensure_ascii=False, indent=2))
        return
    if args.stage == "site":
        print(json.dumps(stage_site(title=args.title, summary=args.summary, url=args.url,
                                    date=args.date, source_key=args.source_key,
                                    project=args.project, site=args.site, token=args.token,
                                    dry_run=args.dry_run), ensure_ascii=False, indent=2))
        return
    if args.stage == "verify":
        print(json.dumps(stage_verify(int(args.file), project=args.project, site=args.site),
                         ensure_ascii=False, indent=2))
        return
    if args.stage == "meta":
        # 只数字数，不碰网络：改摘要时来回跑这个，比 dry-run 更轻
        problems = check_meta(args.title, args.summary)
        print(json.dumps({"ok": not problems, "problems": problems,
                          "meta": meta_stats(args.title, args.summary)},
                         ensure_ascii=False, indent=2))
        sys.exit(0 if not problems else 1)
    if args.stage == "all":
        sys.exit(cmd_all(args))

    print(__doc__)


if __name__ == "__main__":
    main()
