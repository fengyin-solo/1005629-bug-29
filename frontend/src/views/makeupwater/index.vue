<template>
  <section class="page" data-module="makeupwater">
    <header class="page-head">
      <div>
        <h2>补水定压管理</h2>
        <p class="page-desc">维护补水定压记录，围绕记录编号、换热站、补水量、定压值做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记补水定压记录</button>
        <button class="btn" type="button" @click="exportRows">导出补水定压清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="showDetail(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无补水定压数据，可先登记补水定压记录</td>
        </tr>
      </tbody>
    </table>

    <section v-if="selected" class="detail-panel">
      <header class="detail-head">
        <h3>班次详情 · {{ selected['记录编号'] }}</h3>
        <button class="btn ghost" type="button" @click="selected = null">收起</button>
      </header>
      <dl class="detail-grid">
        <template v-for="column in columns" :key="column">
          <dt>{{ column }}</dt>
          <dd>{{ selected[column] ?? '—' }}</dd>
        </template>
        <dt>当前状态</dt>
        <dd>{{ selected.status }}</dd>
      </dl>
      <p class="detail-note">
        详情与列表、导出共用同一份数据；班次归属只按交班时点（08:00 / 20:00）判定，核对通过后锁定不再重算。
      </p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条补水定压记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('makeupwater')
const columns = ["记录编号", "换热站", "补水量", "定压值", "水质硬度", "补水时间", "记录时间", "班次", "操作人", "运行状态"]
const actions = ["提交记录", "确认核对", "标记异常"]
const statuses = ["待记录", "已记录", "已核对", "参数异常"]

const rows = ref<EntryRow[]>([])
// 统计口径与导出一致：同一份去重、同一份班次，不随筛选条件变化。
const statsRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const selected = ref<EntryRow | null>(null)
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  {
    label: '待记录班次',
    value: new Set(
      statsRows.value
        .filter((row) => String(row.status) === '待记录')
        .map((row) => String(row['班次'])),
    ).size,
  },
  {
    label: '已核对记录',
    value: statsRows.value.filter((row) => String(row.status) === '已核对').length,
  },
  {
    label: '参数异常次数',
    value: statsRows.value.filter((row) => String(row.status) === '参数异常').length,
  },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '补水定压记录登记入口尚未接入审批流'
}

// 详情直接取列表里的同一条数据，不另起一套班次算法。
function showDetail(row: EntryRow) {
  selected.value = row
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    statsRows.value = listEntries(meta.key).items
    if (selected.value) {
      const selectedId = Number(selected.value.id)
      selected.value = payload.items.find((row) => Number(row.id) === selectedId) ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '补水定压列表读取失败'
  }
}

onMounted(reload)
</script>
