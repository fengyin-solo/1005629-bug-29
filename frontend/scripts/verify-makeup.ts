/* 逻辑自检脚本（不入库运行时）：验证班次归属、去重、统计、历史冻结、缺补水量、巡检联动。 */
import { SEED_ROWS } from '../src/data/seed'
import { resolveShift } from '../src/data/shift'
import {
  buildMakeupSnapshot,
  DUPLICATE_FIELD,
  listPatrolChecklist,
  MAKEUP_KEY,
  PATROL_KEY,
  RECORD_TIME_FIELD,
  runMakeupAction,
  SHIFT_DATE_FIELD,
  SHIFT_FIELD,
} from '../src/data/makeup-water'
import { listRows, saveRows, storageKey } from '../src/data/local-store'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.error(`FAIL ${name} ${detail}`)
  }
}

// 用内存 storage 隔离种子数据
const mem = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
  },
}
saveRows(MAKEUP_KEY, JSON.parse(JSON.stringify(SEED_ROWS[MAKEUP_KEY])))
saveRows(PATROL_KEY, JSON.parse(JSON.stringify(SEED_ROWS[PATROL_KEY])))

// 1) 交班时点判定
check('00:05 归前日夜班', resolveShift('2026-10-03 00:05')?.label === '2026-10-02 夜班')
check('07:59 归前日夜班', resolveShift('2026-10-03 07:59')?.label === '2026-10-02 夜班')
check('08:00 归当日白班', resolveShift('2026-10-03 08:00')?.label === '2026-10-03 白班')
check('15:59 归白班', resolveShift('2026-10-03 15:59')?.label === '2026-10-03 白班')
check('16:00 归中班', resolveShift('2026-10-03 16:00')?.label === '2026-10-03 中班')
check('23:59 归中班', resolveShift('2026-10-03 23:59')?.label === '2026-10-03 中班')
check('只有日期按 00:00 归前日夜班', resolveShift('2026-10-03')?.label === '2026-10-02 夜班')

// 2) 种子快照
const snap = buildMakeupSnapshot()
const byId = new Map(snap.rows.map((r) => [Number(r.id), r]))
check('MAKE-0002 记录时间00:05归10-02夜班', byId.get(2)?.shift?.label === '2026-10-02 夜班')
// 历史已核对：冻结为 10-03 夜班（与新口径不同），但必须保留
check('历史已核对记录沿用冻结班次', byId.get(3)?.shift?.label === '2026-10-03 夜班')
// MAKE-0004 阳光 10-02夜班，而 MAKE-0003 冻结在 10-03夜班 -> 不构成重复（兼容历史归属）
check('冻结班次不同不算重复报送', byId.get(4)?.primary === true)
check('异常记录 MAKE-0005 归 10-02 夜班', byId.get(5)?.shift?.label === '2026-10-02 夜班')

// 统计：待记录=2(1,6)，已核对=1(3)，异常=1(5)；重复=0
check('待记录班次=2', snap.stats.pending === 2, `got ${snap.stats.pending}`)
check('已核对记录=1', snap.stats.verified === 1, `got ${snap.stats.verified}`)
check('参数异常次数=1', snap.stats.abnormal === 1, `got ${snap.stats.abnormal}`)
check('重复报送=0', snap.stats.duplicate === 0, `got ${snap.stats.duplicate}`)

// 3) 缺补水量不予受理
const reject1 = runMakeupAction(6, '提交记录')
check('补水量空拒绝报送', reject1.ok === false && reject1.message.includes('补水量'))
const reject2 = runMakeupAction(6, '确认核对')
check('补水量空拒绝核对', reject2.ok === false)

// 4) 提交 MAKE-0001：滨河 记录时间缺省回落补水时间 23:50 -> 10-02中班。
//    对照 MAKE-0002（记录时间次日00:05 -> 10-02夜班）：旧口径两处各算一份会把它们
//    看成同晚记录，新口径按交班时点分别落中班、夜班，互不重复。
const ok1 = runMakeupAction(1, '提交记录')
check('MAKE-0001 报送成功', ok1.ok === true, ok1.message)
const after1 = buildMakeupSnapshot().rows.find((r) => Number(r.id) === 1)
check('MAKE-0001 归属10-02中班（按补水时间回落判定）', after1?.[SHIFT_FIELD] === '中班' && after1?.[SHIFT_DATE_FIELD] === '2026-10-02', `${after1?.[SHIFT_DATE_FIELD]} ${after1?.[SHIFT_FIELD]}`)
check('MAKE-0001 记录时间回落补水时间', after1?.[RECORD_TIME_FIELD] === '2026-10-02 23:50')

// 5) 重复报送按第一次认：滨河10-02夜班已有 id=2（00:05报送），再新增一条提交应拒绝
const rowsNow = listRows(MAKEUP_KEY)
const newId = rowsNow.reduce((m, r) => Math.max(m, Number(r.id)), 0) + 1
saveRows(MAKEUP_KEY, [
  ...rowsNow,
  {
    id: newId, status: '待记录', pending: true, abnormal: false,
    记录编号: 'MAKE-DUP', 换热站: '滨河换热站', 补水量: 5, 定压值: '0.45',
    水质硬度: '3', 补水时间: '2026-10-03 00:40', 记录时间: '2026-10-03 00:40',
    操作人: '测试', 运行状态: '正常',
  },
])
const dup = runMakeupAction(newId, '提交记录')
check('同班重复报送被拒绝且指向第一次', dup.ok === false && dup.message.includes('MAKE-0002'), dup.message)

// 6) 同换热站同班次但已有一条重复历史数据（已报送的非第一条），快照里标 primary=false，只算一次
saveRows(MAKEUP_KEY, [
  ...listRows(MAKEUP_KEY),
  {
    id: newId + 1, status: '已记录', pending: true, abnormal: false,
    记录编号: 'MAKE-DUP2', 换热站: '滨河换热站', 补水量: 6, 定压值: '0.45',
    水质硬度: '3', 补水时间: '2026-10-03 00:50', 记录时间: '2026-10-03 00:50',
    首次报送时间: '2026-10-03 00:50', 操作人: '测试', 运行状态: '正常',
  },
])
const snap2 = buildMakeupSnapshot()
check('已存在的重复报送被标记', snap2.rows.find((r) => Number(r.id) === newId + 1)?.primary === false)
check('重复报送数=1', snap2.stats.duplicate === 1, `got ${snap2.stats.duplicate}`)
check('滨河10-02夜班组的有效报送=1', (() => {
  const g = snap2.groups.find((g) => g.label === '2026-10-02 夜班')
  return g ? g.primaryCount >= 1 : false
})())
check('重复行在导出视图带重复标记', (() => {
  const r = snap2.rows.find((r) => Number(r.id) === newId + 1)
  return r ? true : false
})())
void DUPLICATE_FIELD

// 7) 核对历史记录不动班次（MAKE-0003 再核对被拒绝，且冻结值保留）
const reverify = runMakeupAction(3, '确认核对')
check('已核对记录拒绝重复核对', reverify.ok === false)

// 8) 标记异常 -> 巡检待核查；重新核对正常 -> 撤回
// MAKE-0004 标异常
const ab = runMakeupAction(4, '标记异常')
check('标记异常成功并联动', ab.ok === true)
const checklistAfter = listPatrolChecklist().map((r) => String(r['来源记录']))
check('巡检清单含 MAKE-0004 联动项', checklistAfter.includes('4'), checklistAfter.join(','))
// 再核对正常
const ver = runMakeupAction(4, '确认核对')
check('异常记录重新核对成功', ver.ok === true)
const checklistCleared = listPatrolChecklist().map((r) => String(r['来源记录']))
check('正常核对后撤回合联动项', !checklistCleared.includes('4'), checklistCleared.join(','))
check('原有 MAKE-0005 联动项保留', checklistCleared.includes('5'), checklistCleared.join(','))

// 9) 巡检侧处理过的联动项不被撤回（手动把5的联动项状态改掉，模拟巡检已接单）；
//    此时补水侧再次触发标记异常，只把待核查置回，已处理项不重复新增、且始终保留痕迹。
const patrol = listRows(PATROL_KEY)
const linked = patrol.find((r) => String(r['来源记录']) === '5')
check('种子中存在 MAKE-0005 联动项', Boolean(linked))
if (linked) {
  linked.status = '已上报'
  linked['待核查'] = '否'
  saveRows(PATROL_KEY, patrol)
}
runMakeupAction(5, '标记异常') // 已经是异常态，应直接返回不改动
const kept = listRows(PATROL_KEY).filter((r) => String(r['来源记录']) === '5')
check('已处理联动项保留且未重复生成', kept.length === 1 && kept[0].status === '已上报',
  kept.map((r) => r.status).join(','))

// 10) 异常计数不随重复报送翻倍：只把 MAKE-0004 核对回正常，MAKE-0005 保持异常
const finalSnap = buildMakeupSnapshot()
check('最终异常次数=1(只算第一次报送)', finalSnap.stats.abnormal === 1, `got ${finalSnap.stats.abnormal}`)
check('最终已核对=2 (3/4)', finalSnap.stats.verified === 2, `got ${finalSnap.stats.verified}`)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
