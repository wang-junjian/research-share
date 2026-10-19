// ---------------------------------------------------------------------------
// 测试共享的最小可控 fake cloud：模拟云 SDK 的
// database.from(...).select(...).order(...).eq(...) 查询链。
//
// state.rows 可在测试中随时替换，模拟「另一个写入者」（admin 前端经浏览器
// SDK 直连数据库，绕过本进程缓存）；state.queries 计数断言缓存命中/重查次数。
// from() 每次返回前清掉上一条链残留的 eq 过滤，与真实 SDK 的链式语义一致。
//
// 需要 rpc 语义的测试（如 server.test.js 的全栈缝）在此基础上自行挂
// database.rpc；lib/demo-cloud.js 是生产代码，不与此共用。
// ---------------------------------------------------------------------------

export function fakeCloud(rows) {
  const state = { rows, queries: 0 }
  const builder = {
    filters: [],
    select() { return builder },
    order() { return builder },
    eq(col, val) { builder.filters.push([col, val]); return builder },
    then(resolve) {
      state.queries++
      const data = state.rows.filter((r) => builder.filters.every(([c, v]) => r[c] === v))
      return resolve({ data, error: null })
    },
  }
  return {
    state,
    database: {
      // from() 返回同一个 builder，每次调用先清掉上一条链残留的 eq 过滤
      from: () => {
        builder.filters = []
        return builder
      },
    },
  }
}
