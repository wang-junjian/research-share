// ---------------------------------------------------------------------------
// 极简 .env 加载器（零依赖）
//
// 为什么不直接用 dotenv：这个项目只为了读一个 KEY=VALUE 文件，不值得多一个
// 依赖、多一份供应链风险。为什么不直接用 node --env-file：那需要 Node 20.6+，
// 而 --env-file-if-exists（文件不存在时不报错）要 Node 22.9+，门槛太高。
//
// 只支持最常见的形式：KEY=VALUE、# 注释、可选的成对引号。
// 不支持多行值 —— 需要多行的话，直接设真实的环境变量。
//
// 规则：**已存在的环境变量优先**，.env 永远不会覆盖它。
// 这样部署环境注入的配置不会被一个遗留的 .env 文件悄悄顶掉。
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadEnv(file = '.env') {
  const path = resolve(process.cwd(), file)
  if (!existsSync(path)) return false

  const text = readFileSync(path, 'utf8')
  let loaded = 0

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq < 1) continue

    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()

    // 去掉成对引号（不成对的当作值的一部分，避免把写坏的引号吞掉）
    const quoted = (value.startsWith('"') && value.endsWith('"')) ||
                   (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)

    if (process.env[key] === undefined) {
      process.env[key] = value
      loaded++
    }
  }

  return loaded
}
