#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sanitize.py —— 把 HTML 清成「文档型成果」能收的静态 HTML。

用法：
    python3 scripts/sanitize.py <in.html> --out <clean.html> [--check]
    python3 scripts/sanitize.py <in.html>              # 只报告，不写文件

清什么、为什么：

| 目标                | 原因                                                       |
|---------------------|------------------------------------------------------------|
| <script> 全部       | 请求体含 `<script` 时平台边缘 WAF 直接 403，请求到不了应用       |
| on*= 内联事件        | 同上（WAF 红线）                                            |
| javascript: 链接     | 同上                                                        |
| <iframe>            | 同源托管会变成嵌套攻击面，且多为第三方内容，读者也打不开           |
| data-page-node-id 等 | 资料库页面编辑器整篇回写注入的噪音，一份 900 行文档能有 1500 处    |

**代价必须提前讲清楚**：剥掉脚本后，依赖 JS 的交互（目录滚动高亮、tab 切换、
懒加载）会失效。锚点跳转、表格、内联 SVG、纯 CSS 动效不受影响。

只删脚本与注入属性，不动 DOM 结构、不改样式、不重排空白段（除压缩三连空行）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys

# 编辑器回写注入的属性（成对出现，直接剥掉即可）
POLLUTION_ATTRS = (
    re.compile(r'\sdata-page-node-id="[^"]*"'),
    re.compile(r"\sdata-pnid-children=\"[^\"]*\""),
)


def sanitize(text: str) -> tuple[str, dict]:
    """返回 (清理后文本, 统计)。统计里的数字要能直接给人看。"""
    s = text
    stats: dict = {}

    # 1. script 块：先配对删（含编辑器注入的 inject.js），再删自闭合形式
    s, n1 = re.subn(r"<script\b[^>]*>.*?</script\s*>", "", s, flags=re.S | re.I)
    s, n2 = re.subn(r"<script\b[^>]*/>", "", s, flags=re.I)
    stats["script_removed"] = n1 + n2

    # 2. iframe
    s, n3 = re.subn(r"<iframe\b[^>]*>.*?</iframe\s*>", "", s, flags=re.S | re.I)
    s, n4 = re.subn(r"<iframe\b[^>]*/>", "", s, flags=re.I)
    stats["iframe_removed"] = n3 + n4

    # 3. 内联事件属性（onclick= / onload= …，保留 aria-* 等合法属性）
    s, n5 = re.subn(r'\s+on[a-z]+\s*=\s*"[^"]*"', "", s, flags=re.I)
    s, n6 = re.subn(r"\s+on[a-z]+\s*=\s*'[^']*'", "", s, flags=re.I)
    stats["inline_event_removed"] = n5 + n6

    # 4. javascript: 伪协议（链接会变成死链，改成空锚点）
    s, n7 = re.subn(r'javascript\s*:[^"\'\s>]*', "#", s, flags=re.I)
    stats["js_uri_removed"] = n7

    # 5. 编辑器注入属性
    total = 0
    for pat in POLLUTION_ATTRS:
        s, n = pat.subn("", s)
        total += n
    stats["editor_attrs_removed"] = total

    # 6. 只压三连以上空行，避免大段空白（不改语义）
    s, n8 = re.subn(r"\n{3,}", "\n\n", s)
    stats["blank_runs_collapsed"] = n8

    return s, stats


def verify(text: str) -> dict:
    """出口校验：这些数必须全为 0，否则别发。"""
    return {
        "script": len(re.findall(r"<script\b", text, re.I)),
        "inline_event": len(re.findall(r"\son[a-z]+\s*=", text, re.I)),
        "js_uri": len(re.findall(r"javascript\s*:", text, re.I)),
        "iframe": len(re.findall(r"<iframe\b", text, re.I)),
        "editor": len(re.findall(r"data-page-node-id|data-pnid-children|__dm_", text, re.I)),
        "chars": len(text),
    }


def main() -> None:
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("file", nargs="?", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--json", action="store_true")
    args, _ = ap.parse_known_args()

    if not args.file:
        print(json.dumps({"error": "缺少输入文件"}, ensure_ascii=False))
        return
    try:
        text = open(args.file, encoding="utf-8").read()
    except OSError as e:
        print(json.dumps({"error": f"读取失败: {e}"}, ensure_ascii=False))
        return

    clean, stats = sanitize(text)
    v = verify(clean)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(clean)

    result = {
        "in_chars": len(text),
        "out_chars": len(clean),
        "out_kb": round(len(clean.encode()) / 1024, 1),
        "stats": stats,
        "verify": v,
        "clean": all(v[k] == 0 for k in ("script", "inline_event", "js_uri", "iframe", "editor")),
        "out": args.out or None,
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    print(f"字符   {result['in_chars']} → {result['out_chars']}（{result['out_kb']} KB）")
    for k, n in stats.items():
        if n:
            print(f"  删 {k}: {n}")
    print(f"校验   script={v['script']} 内联事件={v['inline_event']} js:={v['js_uri']} "
          f"iframe={v['iframe']} 编辑器痕迹={v['editor']}")
    print(f"结论   {'干净，可用于文档型' if result['clean'] else '仍有残留，别发文档型'}")
    if args.out:
        print(f"输出   {args.out}")
    else:
        print("（未写文件，加 --out <path> 才会落盘）")


if __name__ == "__main__":
    main()
