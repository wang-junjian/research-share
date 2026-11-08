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
    python3 scripts/publish.py meta --title … --summary … [--doc-title …]  # 数字数 + 可机检的编辑审查
    python3 scripts/publish.py shortlist <candidates.json|stdin> # 多组候选一次机检 + 择优排序
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
- 生成目标区间 title 20–40、summary 200–360，由 `review_meta` 出**提示**而非阻断；
  `shortlist` 一次机检多组候选供择优，事实可溯 / 微信钩子 / 读者决策这几项
  脚本判不了，见 references/editorial-standards.md。
- **卡片标题优先沿用文档自己的标题**（h1 优先，无 h1 用 `<title>`）：传
  `--doc-title` 或候选 JSON 的顶层 `doc_title`，机检会标注哪些组是原文标题版
  （`title_is_doc_title`），并对原文标题豁免 20–40 目标区间；300 字硬上限照旧。
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

# 生成目标区间（编辑审查口径，不是接口约束）：与 references/editorial-standards.md 一致
TITLE_TARGET = (20, 40)
SUMMARY_TARGET = (200, 360)
OG_DESC_LIMIT = 80          # lib/render.js renderDetail: truncate(summary, 80)
POSTER_SUMMARY_LIMIT = 220  # renderDetail: data-summary


def utf16_len(s: str) -> int:
    """按服务端口径数字数：JS 的 `s.length` 是 UTF-16 码元数。

    中文、西文各算 1，BMP 以外（emoji、部分符号）算 2 —— Python 的 `len()`
    会把这些算 1，用它当口径就会「本地看着没超、服务端 400」。
    """
    return len(s.encode("utf-16-le")) // 2


def same_title(a: str, b: str) -> bool:
    """判定两个标题是不是同一个：折叠全部空白（含全角空格）后比较。

    文档标题可能来自手工填写的 `--doc-title`、`<title>` 或带 `<br>` 的 h1，
    差一个空格不该让「沿用原标题」被误判成改写版。只用于来源判定，
    不改动真正发出去的 title 字符串。
    """
    norm = lambda x: re.sub(r"[\s\u3000]+", "", x or "").strip()
    return bool(norm(a)) and norm(a) == norm(b)


def check_meta(title: str, summary: str) -> list[str]:
    """校验「能不能发」：必填 + 硬上限。返回问题列表，空列表即通过。

    刻意只做长度与必填、不做文风——文风的机检部分在 review_meta（只提示），
    人工判的部分在 references/editorial-standards.md。这个函数的返回值决定
    cmd_all 会不会退出，加风格规则进来会让已有发布流程无故发不出去。
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
# 技术编辑审查：可机检的那部分
# --------------------------------------------------------------------------
# 与 references/editorial-standards.md 的清单一一对应。这里只覆盖「字数 +
# 禁用套话 + 格式 + 微信钩子」；事实是否属实、结论是否从正文得出、读起来
# 想不想点开，脚本判不了，由按技能执行的智能体逐项人工判（HUMAN_ONLY）。
# 关键：只产 warnings，**不阻断发布**；阻断只认 check_meta 的硬上限。

GENERIC_OG_DESC = "workbuddy - 可人机协作的在线 page"

# (正则, 理由)：理由要能直接当成「这个候选为什么被淘汰 / 改写」用，别只写「不够专业」
BANNED_PATTERNS: list[tuple[str, str]] = [
    (r"本文(?:介绍|阐述|探讨|分享|分析|讲述)了?|本篇(?:介绍|阐述)|这(?:份|篇)文档(?:介绍|讲述|主要)",
     "指代式开场，前 80 字全花在「这份文档」上"),
    (r"深度(?:解析|剖析|解读|分析)|全面(?:梳理|解析|总结|介绍)|一文(?:读懂|搞懂|讲透)|干货|保姆级|重磅|独家|首发",
     "自媒体套话 / 营销腔，制造分量而不传递信息"),
    (r"革命性|颠覆性|业界领先|行业首创|彻底解决|完全解决|完美(?:解决|实现)?|最佳实践|极具价值|非常重要|较强的参考价值",
     "无法证实的绝对化表述，技术读者会直接不信"),
    (r"我们(?:在|通过|将|可以|发现|对|把)?|笔者|本人(?:认为|在)",
     "第一人称，卡片上应直接陈述事实，不要写「我们做了…」"),
    (r"众所周知|不难看出|显而易见|毋庸置疑|值得一提的是|需要注意的是",
     "填充式连接词，删掉不丢信息"),
    (r"等等|诸如此类|限于篇幅|不再赘述|详见全文|这里不再展开",
     "把信息推给正文，卡片上等于没写"),
]

# 只认常见标签名：技术摘要里的 <node_id> / <id> 这类占位符不该被当成 HTML
HTML_TAG_RE = r"<(?:script|p|div|span|a|br|b|i|em|strong|h[1-6]|img|code|pre|ul|ol|li|table|tr|td)\b"

HUMAN_ONLY = [
    "前 80 字是否自带完整结论、脱离标题读得懂",
    "标题是否优先沿用了文档原标题；若改写，是否有对象 / 动作 / 可核对的具体信息及改写理由",
    "每个数字、专名、结论能否在正文里指出出处（不许编造）",
    "摘要是否四段齐备、不写成目录",
    "读者能否判断「跟我有关吗 / 要不要点开」",
]


def review_meta(title: str, summary: str, doc_title: str = "") -> dict:
    """技术编辑审查里**可机检**的部分。返回逐项 checks 与可执行的 warnings。

    与 check_meta 分工：那边判「能不能发」（必填 + 硬上限，会阻断），
    这边判「值不值得发」（目标区间、套话、格式、微信钩子，只提示）。
    所以这里不抛错、不改退出码；pass=true 也**不等于**编辑审查通过。

    `doc_title` 是文档自己的标题（h1 优先，无 h1 用 `<title>`）。SKILL.md 要求
    卡片标题优先沿用它，所以原文标题越过 20–40 目标区间时豁免该判据——原文
    不该为了凑字数被改写；套话、格式、300 字硬上限仍照常生效。
    """
    t, s = (title or "").strip(), (summary or "").strip()
    doc_title = (doc_title or "").strip()
    is_doc_title = same_title(t, doc_title)
    if not t or not s:
        return {"pass": False, "warnings": ["标题或摘要为空，先补齐再审查"],
                "checks": {}, "og_hook": "", "info": [],
                "title_is_doc_title": is_doc_title, "doc_title": doc_title,
                "human_only": HUMAN_ONLY,
                "note": "review 只做可机检项，pass=true 不等于编辑审查通过；人工项见 human_only"}

    n_t, n_s = utf16_len(t), utf16_len(s)
    warnings: list[str] = []
    info: list[str] = []
    checks: dict[str, bool] = {}

    # 1. 生成目标区间（编辑要求，不是接口约束）
    lo, hi = TITLE_TARGET
    # 沿用文档原标题时豁免字数区间：18 字的 h1 也是好标题，不该被硬凑成 20 字
    checks["title_in_target"] = is_doc_title or (lo <= n_t <= hi)
    if not (lo <= n_t <= hi):
        if is_doc_title:
            info.append(f"标题沿用文档原标题（{n_t} 字），越过目标 {lo}–{hi} 字不算问题："
                        "按 SKILL.md 优先原文，不硬凑字数")
        elif n_t < lo:
            warnings.append(f"title {n_t} 字，短于目标 {lo} 字：优先取文档原标题，"
                            "若确需自拟则补上研究对象或结论")
        else:
            warnings.append(f"title {n_t} 字，长于目标 {hi} 字：卡片上会被截，压掉修饰语只留对象 + 动作")

    lo, hi = SUMMARY_TARGET
    checks["summary_in_target"] = lo <= n_s <= hi
    if n_s < lo:
        warnings.append(f"summary {n_s} 字，短于目标 {lo} 字：四段式通常写不满，检查做法 / 证据 / 边界是否缺段")
    elif n_s > hi:
        warnings.append(f"summary {n_s} 字，长于目标 {hi} 字：多半在灌水，按四段式各留一句")

    # 2. 禁用套话与资料库固定 og 文案
    hits: list[str] = []
    seen: set[str] = set()
    for pat, why in BANNED_PATTERNS:
        for m in re.finditer(pat, t + " " + s):
            if m.group(0) in seen:
                continue
            seen.add(m.group(0))
            hits.append(f"{m.group(0)}（{why}）")
    checks["no_banned_phrases"] = not hits
    if hits:
        warnings.append("命中禁用套话：" + "；".join(hits[:4]) + ("…" if len(hits) > 4 else ""))

    checks["not_generic_og"] = GENERIC_OG_DESC not in s.lower()
    if not checks["not_generic_og"]:
        warnings.append("summary 照抄了资料库固定 og 描述，必须按正文重写成实质概览")

    # 3. 格式杂质（卡片 / 海报渲染会出问题）
    fmt: list[str] = []
    if re.search(r"[\r\n]", t + s):
        fmt.append("含换行")
    if re.search(r"^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)|[`*_]{2,}", s, re.M):
        fmt.append("含 markdown 标记")
    if re.search(HTML_TAG_RE, t + s, re.I):
        fmt.append("含 HTML 标签")
    if any(ord(c) > 0xFFFF for c in t + s):
        fmt.append("含 emoji / BMP 外字符")
    if "\u3000" in t + s or re.search(r"[ \t]{2,}", t + s):
        fmt.append("含全角空格或连续空格")
    if re.search(r"(?:…|——|--)\s*$", s):
        fmt.append("以省略号 / 破折号收尾")
    checks["clean_format"] = not fmt
    if fmt:
        warnings.append("格式杂质：" + "、".join(fmt))

    # 4. 微信钩子：og:description 只取前 80 字。判据是**首句能否在 80 字内
    #    收住**——这样微信卡片至少读到一个完整句子，而不是半句。
    hook_text = s[:OG_DESC_LIMIT]
    first = re.split(r"[。！？!?]", s, maxsplit=1)[0].strip()
    first_len = utf16_len(first)
    checks["og_hook_complete"] = first_len <= OG_DESC_LIMIT and bool(re.search(r"[。！？!?]", s))
    if not checks["og_hook_complete"]:
        if first_len > OG_DESC_LIMIT:
            warnings.append(f"首句 {first_len} 字，超过微信卡片的 {OG_DESC_LIMIT} 字："
                            "og:description 会停在半句，把结论压进首句并用句号收住")
        else:
            warnings.append("摘要没有句末标点，微信卡片读不到一个完整句子：给首句补上句号")

    norm_t = re.sub(r"[\s：:，,。·—-]", "", t)
    norm_s = re.sub(r"[\s：:，,。·—-]", "", s)
    checks["title_not_echoed"] = not (len(norm_t) >= 10 and norm_s.startswith(norm_t[:28]))
    if not checks["title_not_echoed"]:
        warnings.append("summary 开头原样复述了标题：最金贵的前 80 字别用来重说一遍")

    # 5. 四段式第 ③ 段要求的可复核数字（弱提示，确实没有就在候选对比表里写理由）
    checks["has_verifiable_number"] = bool(re.search(r"\d", s))
    if not checks["has_verifiable_number"]:
        warnings.append("摘要里没有阿拉伯数字：四段式第 ③ 段要有一处可复核的数字"
                        "（条数 / 字节数 / 状态码 / 耗时），按正文补上")

    return {
        "pass": not warnings,
        "warnings": warnings,
        "checks": checks,
        # 信息项（不进 warnings）：原文标题版豁免了字数区间，把理由留痕
        "info": info,
        "title_is_doc_title": is_doc_title,
        "doc_title": doc_title,
        "targets": {
            "title": list(TITLE_TARGET),
            "summary": list(SUMMARY_TARGET),
            "og_description": OG_DESC_LIMIT,
            "poster_summary": POSTER_SUMMARY_LIMIT,
        },
        # 与 render.js 的 truncate 同口径：按 UTF-16 码元取前 80，超出补省略号
        "og_hook": hook_text + ("…" if n_s > OG_DESC_LIMIT else ""),
        "first_sentence_len": first_len,
        # 信息项（不进 warnings）：卡片末尾停在句中是常见的，只要首句完整就不算问题
        "og_hook_truncated_mid_sentence": n_s > OG_DESC_LIMIT and not re.search(r"[。！？!?；;]$", hook_text),
        "human_only": HUMAN_ONLY,
        "note": "review 只做可机检项，pass=true 不等于编辑审查通过；人工项见 human_only",
    }


def load_candidates(path: str) -> tuple[list[dict], str]:
    """读一批候选：文件路径或 stdin；也接受 {"candidates": [...]} 包装。

    每组至少要有 title / summary，id 缺省按 A / B / C 顺序补。
    包装对象里的 `doc_title`（文档自己的标题）会一起带出，供机检标注哪几组
    沿用了原文标题；也可用 `shortlist --doc-title` 覆盖。
    """
    raw = open(path, encoding="utf-8").read() if path else sys.stdin.read()
    data = json.loads(raw)
    doc_title = ""
    if isinstance(data, dict):
        doc_title = str(data.get("doc_title") or "")
        data = data.get("candidates")
    if not isinstance(data, list) or not data:
        raise ValueError("应是至少含 1 组候选的数组，或含 candidates 数组的对象")
    out: list[dict] = []
    for i, c in enumerate(data):
        if not isinstance(c, dict):
            raise ValueError(f"第 {i + 1} 组不是对象")
        out.append({
            "id": str(c.get("id") or (chr(ord("A") + i) if i < 26 else str(i + 1))),
            "title": str(c.get("title") or ""),
            "summary": str(c.get("summary") or ""),
        })
    return out, doc_title


def rank_candidates(candidates: list[dict], doc_title: str = "") -> dict:
    """对一批候选做机检排序，给出**机检**推荐（不是定稿）。

    排序只按可机检项：能否发布（硬上限）→ warnings 数 → 与目标区间的贴合度。
    7 项清单里的 3～7 是内容判定，脚本不代劳；recommended 只是择优的起点。
    SKILL.md 要求优先沿用文档原标题：**机检合格的原文标题版排在最前**，
    并标出 title_is_doc_title / doc_title_candidates。没传 doc_title 时这一项
    对所有候选相同，排序与旧版一致；判据本身（warnings、区间）不变。
    """
    doc_title = (doc_title or "").strip()
    rows: list[dict] = []
    t_mid, s_mid = sum(TITLE_TARGET) / 2, sum(SUMMARY_TARGET) / 2
    for c in candidates:
        t, s = c["title"], c["summary"]
        problems = check_meta(t, s)
        rv = review_meta(t, s, doc_title=doc_title)
        st = meta_stats(t, s)
        dist = abs(st["title_len"] - t_mid) / t_mid + abs(st["summary_len"] - s_mid) / s_mid
        eligible = not problems and rv.get("pass", False)
        rows.append({
            "id": c["id"],
            "title": t,
            "title_len": st["title_len"],
            "title_is_doc_title": rv.get("title_is_doc_title", False),
            "summary_len": st["summary_len"],
            "ok": not problems,                        # 能不能发（硬上限）
            "review_pass": rv.get("pass", False),      # 机检过不过
            "eligible": eligible,
            "problems": problems,
            "warnings": rv.get("warnings", []),
            "failed_checks": [k for k, v in rv.get("checks", {}).items() if not v],
            "og_hook": rv.get("og_hook", ""),
            "first_sentence_len": rv.get("first_sentence_len", 0),
            "_score": (0 if eligible else 1,
                       0 if (eligible and rv.get("title_is_doc_title")) else 1,
                       len(rv.get("warnings", [])), round(dist, 4)),
        })
    rows.sort(key=lambda r: r["_score"])
    for r in rows:
        r.pop("_score", None)
    best = rows[0] if rows and rows[0]["eligible"] else None
    native = [r["id"] for r in rows if r["title_is_doc_title"]]
    native_note = ("本批原文标题版：" + "、".join(native) + "，按 SKILL.md 应优先选它"
                   if native else "本批没有原文标题版：检查是否漏放，或在对比表写明原标题为何不适用")
    return {
        "ok": True,
        "count": len(rows),
        "doc_title": doc_title,
        "doc_title_candidates": native,
        "candidates": rows,
        "recommended": best["id"] if best else None,
        "recommend_reason": (
            (f"{best['id']} 机检零警告、未踩硬上限"
             + ("，且沿用了文档原标题（优先项）" if best["title_is_doc_title"]
                else "，字数最贴近目标区间"))
            if best else "整批都没有通过机检：按 7 项清单逐组复核后再生成一批，最多 3 批"
        ),
        "human_only": HUMAN_ONLY,
        "note": "recommended 按「原文标题版优先 + 可机检项最优」排序，仍只是形式判断；"
                + native_note + "。最终定稿须按 7 项清单逐组人工判，"
                  "改写原标题要写明理由，并按读者场景选角度，不选最华丽的那一版",
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
    # 而且**不能拿条目标题去比**：条目标题可能沿用 h1 原文、也可能由编辑改写，
    # 公开页的 <title> 是文档原始标签标题，两者不保证一致。
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
    # --title > 文档自己的标题（h1 优先，无 h1 用 <title>）> 文件名。
    # SKILL.md 要求优先沿用文档原标题；显式 --title 是编辑改写版，优先级更高。
    # 不用资料库改写后的语义名当兜底——那要等第 1 跳跑完才知道，没法前置校验。
    doc_title = re.sub(r"\s+", " ", pre.get("h1") or pre.get("title") or "").strip()
    title = (args.title or "").strip()
    if not title:
        title = doc_title
    if not title:
        title = os.path.splitext(os.path.basename(args.file))[0]

    meta_problems = check_meta(title, args.summary)
    report["meta"] = meta_stats(title, args.summary)
    report["meta"]["title_source"] = (
        "arg" if args.title else "doc_h1" if pre.get("h1")
        else "doc_title_tag" if pre.get("title") else "filename"
    )
    report["meta"]["doc_title"] = doc_title
    report["meta"]["title_is_doc_title"] = same_title(title, doc_title)
    # 审查结论随报告一起走（dry-run 也有），但只有硬上限会阻断；定稿应是
    # `shortlist` 多候选择优的结果，7 项人工判定由按技能执行的智能体负责，
    # 见 references/editorial-standards.md
    report["review"] = review_meta(title, args.summary, doc_title=doc_title)
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
        rv = report["review"]
        print(f"字数          标题 {m['title_len']}/{m['title_max']} · "
              f"摘要 {m['summary_len']}/{m['summary_max']}")
        review_line = "机检通过" if rv["pass"] else f"机检 {len(rv['warnings'])} 条提示"
        print(f"编辑审查      {review_line} · 人工项 {len(rv['human_only'])} 项需逐项判（定稿应来自多候选择优）")
        for w in rv["warnings"][:3]:
            print(f"  - {w}")
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
    ap.add_argument("--doc-title", dest="doc_title", default="",
                    help="文档自己的标题（h1 优先）；用于标注哪些候选沿用了原文标题")
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
        # 数字数 + 机检编辑项，不碰网络：改摘要时来回跑这个，比 dry-run 更轻。
        # 退出码只由 check_meta 决定 —— review 的 warnings 是提示，不该挡住发布。
        problems = check_meta(args.title, args.summary)
        st = meta_stats(args.title, args.summary)
        doc_title = (args.doc_title or "").strip()
        st["doc_title"] = doc_title
        st["title_is_doc_title"] = same_title(args.title, doc_title)
        print(json.dumps({"ok": not problems, "problems": problems,
                          "meta": st,
                          "review": review_meta(args.title, args.summary, doc_title=doc_title)},
                         ensure_ascii=False, indent=2))
        sys.exit(0 if not problems else 1)
    if args.stage == "shortlist":
        # 一次机检多组候选并排序：主流程是「生成多版 → 择优」，不是串行返工。
        # 无合格候选时 exit 1，提示换一批；仍不阻断任何真实发布动作。
        try:
            cands, inline_doc_title = load_candidates(args.file)
            result = rank_candidates(cands, doc_title=args.doc_title or inline_doc_title)
        except (OSError, ValueError) as e:
            print(json.dumps({"ok": False, "error": f"候选读取失败：{e}"},
                             ensure_ascii=False, indent=2))
            sys.exit(1)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0 if result["recommended"] else 1)
    if args.stage == "all":
        sys.exit(cmd_all(args))

    print(__doc__)


if __name__ == "__main__":
    main()
