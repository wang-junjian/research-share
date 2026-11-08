#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""precheck.py —— 发布前体检：这个文件能不能走通两跳。

用法：
    python3 scripts/precheck.py <file> [--json]

检查三层，任何一层不过都不该继续往下发布：

1. 文件层：存在、非空、扩展名、大小上限（上传 50MiB / 文档型 1M 字符）
2. 内容层：标题可提取（资料库用 <title> 命名页面，站点用 ≤300 字的标题）
3. 红线层：<script / 内联事件 / javascript: —— 这三样会让平台边缘 WAF 直接
   返回 403，请求到不了应用。链接型模式**不受此限**（原文托管在资料库），
   文档型模式（kind=doc）必须清零。

同时报告编辑器污染（data-page-node-id 等）——它只出现在资料库导出的副本里，
原件通常是干净的。看到污染说明你手上是导出件，不是原件。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys

UPLOAD_MAX_BYTES = 50 * 1024 * 1024   # import_html.py 的上限
DOC_MAX_CHARS = 1_000_000             # research-share doc_html 的上限（db/06 CHECK）

# 平台边缘 WAF 的三条红线（ADR-0004 修订一）
RED_LINES = {
    "script_tag": re.compile(r"<script\b", re.I),
    "inline_event": re.compile(r"\son[a-z]+\s*=", re.I),
    "js_uri": re.compile(r"javascript\s*:", re.I),
}
# 编辑器回写注入的痕迹
POLLUTION = {
    "page_node_id": re.compile(r"data-page-node-id", re.I),
    "pnid_children": re.compile(r"data-pnid-children", re.I),
    "dm_style": re.compile(r"__dm_", re.I),
    "inject_js": re.compile(r"/page/page_comm/inject\.js", re.I),
}
EXTERNAL_REF = re.compile(r'(?:src|href)\s*=\s*"(?:https?:)?//', re.I)


def extract_title(text: str) -> tuple[str, str]:
    """返回 (title, h1)。资料库用 <title> 命名；站点卡片标题优先沿用 h1 原文。"""
    t = re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S)
    h = re.search(r"<h1[^>]*>(.*?)</h1>", text, re.I | re.S)

    def clean(s: str) -> str:
        # h1 里常用 <br> 做视觉换行（实测「…云服务<br>全景研究」）：那是排版，
        # 不是词间空格。先删掉，否则抠出的标题会多出一个空格，卡片上也跟着多。
        s = re.sub(r"<(?:br|wbr)\s*/?>", "", s, flags=re.I)
        s = re.sub(r"<[^>]+>", " ", s)
        s = re.sub(r"&[^;]+;", " ", s)
        return re.sub(r"\s+", " ", s).strip()

    return (clean(t.group(1)) if t else "", clean(h.group(1)) if h else "")


def check(path: str) -> dict:
    """体检并返回结构化结果。verdict 取值：ok / needs_sanitize / blocked。"""
    out: dict = {"path": os.path.abspath(path), "ok": False, "problems": []}

    if not os.path.isfile(path):
        out["verdict"] = "blocked"
        out["problems"].append("文件不存在")
        return out

    size = os.path.getsize(path)
    ext = os.path.splitext(path)[1].lower()
    out.update(size_bytes=size, size_kb=round(size / 1024, 1), ext=ext)

    if size == 0:
        out["verdict"] = "blocked"
        out["problems"].append("文件为空")
        return out
    if size > UPLOAD_MAX_BYTES:
        out["verdict"] = "blocked"
        out["problems"].append(f"超过上传上限 {UPLOAD_MAX_BYTES // 1024 // 1024}MiB")

    with open(path, "rb") as f:
        raw = f.read()
    out["sha256"] = hashlib.sha256(raw).hexdigest()[:16]

    # 非 HTML（md / pdf / docx）只做文件层判断：它们不会是「页面」，走不了 publish_page
    if ext not in (".html", ".htm"):
        out["is_html"] = False
        out["verdict"] = "blocked"
        out["problems"].append(
            f"{ext} 不是 HTML：资料库只在 .html/.htm 上生成「页面」节点，"
            "而 publish_page 只对页面节点有效。先转成单文件 HTML 再发布。"
        )
        return out

    text = raw.decode("utf-8", errors="replace")
    out["is_html"] = True
    out["chars"] = len(text)
    title, h1 = extract_title(text)
    out.update(title=title, h1=h1)

    if not title and not h1:
        out["problems"].append("取不到 <title> 或 <h1>：资料库会用文件名兜底，标题需人工指定")
    if len(title) > 300 or len(h1) > 300:
        out["problems"].append("标题超过 300 字（站点 title 上限）")
    if len(text) > DOC_MAX_CHARS:
        out["problems"].append(
            f"字符数 {len(text)} 超过文档型上限 {DOC_MAX_CHARS}：只能走链接型"
        )

    out["red_lines"] = {k: len(p.findall(text)) for k, p in RED_LINES.items()}
    out["pollution"] = {k: len(p.findall(text)) for k, p in POLLUTION.items()}
    out["external_refs"] = len(EXTERNAL_REF.findall(text))

    red_total = sum(out["red_lines"].values())
    poll_total = sum(out["pollution"].values())

    if poll_total:
        out["problems"].append(
            f"检测到编辑器回写痕迹 {poll_total} 处（data-page-node-id 等）："
            "这是资料库导出的副本，不是原件。用原件重做，或先跑 scripts/sanitize.py"
        )

    if red_total:
        out["verdict"] = "needs_sanitize"
        out["problems"].append(
            f"命中 WAF 红线 {red_total} 处（{out['red_lines']}）："
            "链接型可用，文档型必须先 sanitize"
        )
    else:
        out["verdict"] = "blocked" if out["problems"] and not out.get("title") and not out.get("h1") else "ok"

    out["ok"] = out["verdict"] == "ok"
    return out


def main() -> None:
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("file", nargs="?", default="")
    ap.add_argument("--json", action="store_true")
    args, _ = ap.parse_known_args()

    if not args.file:
        print(json.dumps({"error": "缺少文件路径"}, ensure_ascii=False))
        return
    if args.json:
        print(json.dumps(check(args.file), ensure_ascii=False, indent=2))
        return

    r = check(args.file)
    print(f"文件   {r['path']}")
    print(f"体积   {r.get('size_kb', '?')} KB  sha256:{r.get('sha256', '?')}")
    print(f"标题   {r.get('title') or '（无 <title>）'}")
    print(f"h1     {r.get('h1') or '（无 <h1>）'}")
    print(f"字符   {r.get('chars', '-')}")

    red = r.get("red_lines") or {}
    print(f"红线   script={red.get('script_tag', 0)}  内联事件={red.get('inline_event', 0)}  javascript:={red.get('js_uri', 0)}")
    poll = sum((r.get("pollution") or {}).values())
    print(f"污染   {poll} 处编辑器痕迹   外链 {r.get('external_refs', 0)} 处")
    print(f"\n判定   {r['verdict']}")
    for p in r["problems"]:
        print(f"  · {p}")
    if r["verdict"] == "ok":
        print("  · 可发布（文档型与链接型都行）")
    elif r["verdict"] == "needs_sanitize":
        print("  · 链接型可直接发布；文档型先跑：python3 scripts/sanitize.py <file> --out clean.html")


if __name__ == "__main__":
    main()
