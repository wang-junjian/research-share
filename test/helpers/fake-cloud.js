// ---------------------------------------------------------------------------
// 测试共享的最小可控 fake cloud：模拟云 SDK 的查询链与写链。
//
// 读链：database.from(table).select(...).order(...).eq(...)/in(...) → 过滤后返回
// 写链：.insert(payload) / .update(patch) / .delete()（配合 eq/in 过滤）→ 返回
//   受影响行；rpc 经 state.rpcHandlers 按名注册仿真。
//
// state 上可调的控制面：
//   rows            research_items 的行（向后兼容别名，等价 tables.research_items），
//                   测试中随时替换，模拟「另一个写入者」（admin 前端经浏览器 SDK
//                   直连数据库，绕过本进程缓存）
//   tables          多表行数据（按 from(table) 的表名分槽，未知名自动开空表）
//   queries         读链计数，断言缓存命中/重查次数
//   reads           读链记录 [{ table, columns, orders, filters }]，
//                   供断言 select 列清单与排序
//   writes          写链记录 [{ table, type, payload|patch, filters, affected }]，
//                   供断言 payload 形状
//   error           注入 SDK 的 res.error（每条链 resolve { data:null, error }，
//                   rpc 同此），测 res.error → App.msg 的翻译；置 null 恢复
//   rejectWith      注入整条链 reject（网络级失败，rpc 同此），测 reject 路径的翻译
//   silentBlock     模拟 RLS 静默拦截：写链动 0 行、不报 error（data 为 []）
//
// 0 行语义：update/delete 经 eq/in 过滤不到行时自然 affected=[]；insert 的
// 0 行只有 silentBlock 能造出（真实环境对应 RLS 拦下 returning 读回）。
//
// from() 每次返回新 builder，链上状态（过滤条件、写操作）不跨链残留。
// ---------------------------------------------------------------------------

export function fakeCloud(rows) {
  const state = {
    tables: { research_items: rows },
    queries: 0,
    reads: [],
    writes: [],
    error: null,
    rejectWith: null,
    silentBlock: false,
    rpcHandlers: {},
  }
  // 向后兼容：既有消费方直接读写 state.rows（单表场景）
  Object.defineProperty(state, 'rows', {
    get: () => state.tables.research_items,
    set: (v) => { state.tables.research_items = v },
  })

  function tableRows(table) {
    if (!state.tables[table]) state.tables[table] = []
    return state.tables[table]
  }

  function matching(rows, filters) {
    return rows.filter((r) =>
      filters.every(([op, col, val]) => (op === 'eq' ? r[col] === val : val.includes(r[col]))))
  }

  function makeBuilder(table) {
    const builder = {
      filters: [],
      columns: undefined,
      orders: [],
      op: null, // null=读链 | { type:'insert', payload } | { type:'update', patch } | { type:'delete' }
      select(cols) { builder.columns = cols; return builder },
      order(col, opts) { builder.orders.push([col, opts]); return builder },
      eq(col, val) { builder.filters.push(['eq', col, val]); return builder },
      in(col, vals) { builder.filters.push(['in', col, vals]); return builder },
      insert(payload) { builder.op = { type: 'insert', payload }; return builder },
      update(patch) { builder.op = { type: 'update', patch }; return builder },
      delete() { builder.op = { type: 'delete' }; return builder },
      then(resolve, reject) {
        if (state.rejectWith) return reject && reject(state.rejectWith)
        if (state.error) return resolve({ data: null, error: state.error })
        if (!builder.op) {
          state.queries++
          state.reads.push({
            table,
            columns: builder.columns,
            orders: builder.orders,
            filters: builder.filters,
          })
          return resolve({ data: matching(tableRows(table), builder.filters), error: null })
        }
        const op = builder.op
        const rows = tableRows(table)
        let affected = []
        if (!state.silentBlock) {
          if (op.type === 'insert') {
            affected = (Array.isArray(op.payload) ? op.payload : [op.payload]).map((r) => ({ ...r }))
            state.tables[table] = rows.concat(affected)
          } else if (op.type === 'update') {
            affected = matching(rows, builder.filters)
            affected.forEach((r) => Object.assign(r, op.patch))
          } else if (op.type === 'delete') {
            affected = matching(rows, builder.filters)
            state.tables[table] = rows.filter((r) => !affected.includes(r))
          }
        }
        state.writes.push({ table, ...op, filters: builder.filters, affected })
        return resolve({ data: affected, error: null })
      },
    }
    return builder
  }

  return {
    state,
    database: {
      from: (table) => makeBuilder(table),
      rpc: (name, args) => ({
        then(resolve, reject) {
          if (state.rejectWith) return reject && reject(state.rejectWith)
          if (state.error) return resolve({ data: null, error: state.error })
          const handler = state.rpcHandlers[name]
          return resolve(
            handler
              ? handler(args)
              : { data: null, error: { code: '42883', message: `function ${name} not found` } })
        },
      }),
    },
  }
}
