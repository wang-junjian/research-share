// 以应用进程的身份（anon = 仅 publishableKey、无登录会话）试探边界。
// 只读探测 + 三条"应当失败"的写入，不会真的改到数据。
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'

const cloud = createWorkBuddyCloud({
  endpoint: process.env.CLOUD_ENDPOINT,
  publishableKey: process.env.CLOUD_PUBLISHABLE_KEY,
})

const line = (label, ok, detail) => console.log(`${ok ? '✓ 拦住了' : '✗ 放行了'}  ${label.padEnd(30)} ${detail}`)

// 1) token 表：anon 不该有任何权限
{
  const { data, error } = await cloud.database.from('agent_tokens').select('id, name, token_hash')
  line('读 agent_tokens', !!error, error ? `${error.code || ''} ${error.message}` : `!! 拿到 ${JSON.stringify(data)}`)
}

// 2) 业务表：anon 应有 SELECT（网站靠它渲染）
{
  const { data, error } = await cloud.database.from('research_items').select('id')
  line('读 research_items', false, error ? `!! ${error.message}` : `${data.length} 条（预期 4）`)
}

// 3) 业务表直连 INSERT：anon 没有 INSERT 权限，必须失败
{
  const { data, error } = await cloud.database
    .from('research_items')
    .insert({ title: '不该写进去', summary: '不该写进去', url: 'https://example.com' })
    .select()
  line('直连 INSERT 业务表', !!error, error ? `${error.code || ''} ${error.message}` : `!! 写入成功 ${JSON.stringify(data)}`)
}

// 4) 内部 token 校验函数：EXECUTE 已被收回，必须调不到
{
  const { data, error } = await cloud.database.rpc('agent_check_token', { p_token: 'rsa_probe_probe_probe_1234' })
  line('调 agent_check_token', !!error, error ? `${error.code || ''} ${error.message}` : `!! 返回 ${JSON.stringify(data)}`)
}

// 5) 写入口函数 + 伪造 token：应被函数内部的 token 校验拒绝
{
  const { data, error } = await cloud.database.rpc('agent_upsert_item', {
    p_token: 'rsa_probe_probe_probe_1234',
    p_title: '不该写进去',
    p_summary: '不该写进去',
    p_url: 'https://example.com',
  })
  line('写入口 + 伪造 token', !!error, error ? `${error.code || ''} ${error.message}` : `!! 写入成功 ${JSON.stringify(data)}`)
}

// 6) 收尾：确认表内仍是 4 条
{
  const { data } = await cloud.database.from('research_items').select('id')
  console.log(`\n收尾：research_items 现有 ${data.length} 条，id = [${data.map((x) => x.id).sort((a, b) => a - b).join(', ')}]`)
}
