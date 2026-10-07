import { useCallback, useEffect, useMemo, useState } from 'react'

const LS_ENVS = 'ipgw_envs' // 环境列表，存浏览器
const LS_ENV_IDX = 'ipgw_env_current'

// 默认环境（首次打开时预置，之后一切以浏览器里存的为准）
const DEFAULT_ENVS = [
  { name: '本地', url: 'http://127.0.0.1:18080' },
  { name: '线上', url: 'https://golang-ip-gateway.98maihua.com' },
]

// 规范化地址：补协议、去尾部斜杠、支持直接粘贴 .../healthz
const normalizeUrl = (u) => {
  let s = (u || '').trim()
  if (!s) return ''
  if (!/^https?:\/\//.test(s)) s = 'http://' + s
  s = s.replace(/\/+$/, '')
  s = s.replace(/\/healthz$/, '')
  return s
}

const loadEnvs = () => {
  try {
    const v = JSON.parse(localStorage.getItem(LS_ENVS) || 'null')
    if (Array.isArray(v) && v.length && v.every((e) => e && typeof e.url === 'string')) {
      return v.map((e) => ({ name: e.name || '未命名', url: normalizeUrl(e.url) }))
    }
  } catch { /* 忽略坏数据 */ }
  return DEFAULT_ENVS
}

const SOURCE_TEXT = {
  file: '本地文件兜底',
  redis: 'Redis 规则',
  admin: '管理后台保存',
}

const normType = (t) => (t === 'random' || t === 'segment' ? t : 'basic')

const MODE_NAME = { random: '分类1 · 随机分配', segment: '分类2 · IP 分段', region: '分类3 · 区域分流' }

// ===== 示例演示数据（Demo 页一键导入用）=====
const DEMO = {
  segment: {
    group: { host: '', cidr: '10.0.0.0/8', targets: ['https://s1.example.com', 'https://s2.example.com', 'https://s3.example.com'], enable: true, remark: '演示：10开头 IP 自动三等分' },
    cases: ['10.0.0.1', '10.100.0.1', '10.200.0.1'],
  },
  random: {
    group: { host: '', targets: ['https://r1.example.com', 'https://r2.example.com', 'https://r3.example.com'], weights: [50, 30, 20], enable: true, remark: '演示：按权重 50/30/20 分流（IP 固定）' },
    cases: ['8.8.8.8', '114.114.114.114', '1.2.4.8', '223.5.5.5'],
  },
  region: {
    rows: [
      { kw: '广东', target: 'https://gd.example.com' },
      { kw: '北京', target: 'https://bj.example.com' },
      { kw: '美国', target: 'https://us.example.com' },
    ],
    cases: ['14.215.177.39', '202.96.134.33', '61.135.169.121', '8.8.8.8', '36.152.44.96'],
  },
}

// 区域演示用的真实 IP 池（归属地已校准：广东/广东/北京/美国）
const REGION_DEMO_IPS = ['14.215.177.39', '202.96.134.33', '61.135.169.121', '8.8.8.8']

// 从网段推一个默认测试 IP：单 IP 用它本身，网段用网络地址 +1
const guessIP = (cidr) => {
  const s = (cidr || '').trim()
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/)
  if (!m) return ''
  const oct = m.slice(1, 5).map(Number)
  if (oct.some((n) => n > 255)) return ''
  if (m[5] === undefined || m[5] === '32') return oct.join('.')
  const next = (((oct[0] << 24) | (oct[1] << 16) | (oct[2] << 8) | oct[3]) >>> 0) + 1
  return [(next >>> 24) & 255, (next >>> 16) & 255, (next >>> 8) & 255, next & 255].join('.')
}

// 计算分段预览：网段均分成 n 段，返回每段的 IP 范围（仅 IPv4）
const segPreview = (cidr, n) => {
  const m = (cidr || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/)
  if (!m || n < 1) return null
  const oct = m.slice(1, 5).map(Number)
  if (oct.some((x) => x > 255)) return null
  const bits = m[5] === undefined ? 32 : Number(m[5])
  if (bits > 32) return null
  const base = ((oct[0] << 24) | (oct[1] << 16) | (oct[2] << 8) | oct[3]) >>> 0
  const total = 2 ** (32 - bits)
  const segLen = Math.max(1, Math.floor(total / n))
  const toIp = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.')
  return Array.from({ length: Math.min(n, 50) }, (_, i) => {
    const start = (base + i * segLen) >>> 0
    const endRaw = Math.min(base + (i + 1) * segLen, base + total, 0xffffffff)
    return { no: i + 1, start: toIp(start), end: toIp((endRaw - 1) >>> 0) }
  })
}

export default function App() {
  // ===== 环境 =====
  const [envs, setEnvs] = useState(loadEnvs)
  const [curIdx, setCurIdx] = useState(() => {
    const i = Number(localStorage.getItem(LS_ENV_IDX))
    return i >= 0 && i < loadEnvs().length ? i : 0
  })
  const [envEditorOpen, setEnvEditorOpen] = useState(false)
  const [health, setHealth] = useState(null) // { ok, data?, err? }

  const cur = envs[curIdx] || envs[0]
  const baseUrl = cur?.url || ''

  // ===== 页面与数据 =====
  const [page, setPage] = useState('config') // config | demo
  const [defaultTarget, setDefaultTarget] = useState('')
  const [source, setSource] = useState('')
  const [msg, setMsg] = useState(null)
  const [saving, setSaving] = useState(false)

  // 分类1：随机分配 —— 只需要域名列表，IP 段固定为全部（0.0.0.0/0）
  const [ran, setRan] = useState({ id: '', raw: null, host: '', targets: [], weights: [], enable: true, remark: '' })
  // 分类2：IP 分段 —— 一段 IP + 域名列表（按顺序均分）
  const [seg, setSeg] = useState({ id: '', raw: null, host: '', cidr: '', targets: [], enable: true, remark: '' })
  // 分类3：区域分流 —— 关键词（国家/省/市/运营商）→ 域名，逐行匹配
  const [regRows, setRegRows] = useState([
    { kw: '广东', target: 'https://gd.example.com' },
    { kw: '北京', target: 'https://bj.example.com' },
    { kw: '美国', target: 'https://us.example.com' },
  ])
  // 互斥单选：同一时间只启用一个分类；effectiveMode 是网关当前实际生效的分类
  const [mode, setMode] = useState(null) // 'random' | 'segment' | 'region'（正在编辑/保存的分类）
  const [effectiveMode, setEffectiveMode] = useState('') // '' = 未启用任何分类
  const [stats, setStats] = useState(null)
  const [demoRows, setDemoRows] = useState(null) // 演示结果行
  const [demoRunning, setDemoRunning] = useState(false)
  const [demoTraffic, setDemoTraffic] = useState(null) // { sent, total }
  const [tests, setTests] = useState({})

  // 所有接口都打到当前选中环境
  const apiFetch = useCallback((path, opts) => fetch(baseUrl + path, opts), [baseUrl])

  const checkHealth = useCallback(async () => {
    if (!baseUrl) return
    try {
      const res = await apiFetch('/healthz')
      const d = await res.json()
      setHealth({ ok: res.ok, data: d })
    } catch (e) {
      setHealth({ ok: false, err: e.message })
    }
  }, [apiFetch, baseUrl])

  const load = useCallback(async () => {
    const res = await apiFetch('/admin/rules')
    if (!res.ok) throw new Error(`GET /admin/rules ${res.status}`)
    const data = await res.json()
    setDefaultTarget(data.default_target || '')
    setSource(data.source || '')
    const rules = data.rules || []
    const segR = rules.find((r) => normType(r.type) === 'segment')
    const ranR = rules.find((r) => normType(r.type) === 'random')
    const regRs = rules.filter((r) => normType(r.type) === 'region')
    setRegRows(
      regRs.length
        ? regRs.map((r) => ({ kw: r.country || '', target: r.target || '' }))
        : [
            { kw: '广东', target: 'https://gd.example.com' },
            { kw: '北京', target: 'https://bj.example.com' },
            { kw: '美国', target: 'https://us.example.com' },
          ],
    )
    setSeg(
      segR
        ? { id: segR.id || '', raw: segR, host: segR.host || '', cidr: segR.ip_cidr || '', targets: segR.targets || [], enable: !!segR.enable, remark: segR.remark || '' }
        : { id: '', raw: null, host: '', cidr: '10.0.0.0/8', targets: ['https://s1.example.com', 'https://s2.example.com', 'https://s3.example.com'], enable: true, remark: '' },
    )
    setRan(
      ranR
        ? { id: ranR.id || '', raw: ranR, host: ranR.host || '', targets: ranR.targets || [], weights: Array.isArray(ranR.weights) ? ranR.weights : (ranR.targets || []).map(() => 0), enable: !!ranR.enable, remark: ranR.remark || '' }
        : { id: '', raw: null, host: '', targets: [''], weights: [0], enable: true, remark: '' },
    )
    // 当前生效分类：分段 > 随机 > 区域（历史数据兼容），都没有 = 未启用
    const eff = segR ? 'segment' : ranR ? 'random' : regRs.length ? 'region' : ''
    setEffectiveMode(eff)
    setMode((m) => m ?? (eff || 'random')) // 首次进入默认展示一个分类的表单
    await checkHealth()
  }, [apiFetch, checkHealth])

  const loadStats = useCallback(async () => {
    try {
      const res = await apiFetch('/admin/stats')
      if (res.ok) setStats(await res.json())
    } catch { /* 环境离线时静默 */ }
  }, [apiFetch])

  useEffect(() => {
    loadStats()
    const t = setInterval(loadStats, 10000)
    return () => clearInterval(t)
  }, [loadStats])

  // 切换环境 / 首次加载 → 自动拉取该环境配置并测连接
  useEffect(() => {
    setTests({})
    setHealth(null)
    load().catch((e) => {
      setHealth({ ok: false, err: e.message })
      setMsg({
        type: 'err',
        text: `当前环境「${cur?.name}」连接失败：${e.message}。若这是线上环境，多半是服务器网关还是旧版（不支持浏览器跨域直连），按 doc/04 第 9 节用 ip-gateway-linux-amd64 更新并重启即可。`,
      })
    })
  }, [load, cur?.name])

  const switchEnv = (i) => {
    setCurIdx(i)
    localStorage.setItem(LS_ENV_IDX, String(i))
    setMsg(null)
  }

  // ===== 环境编辑 =====
  const saveEnvs = (list, selectIdx) => {
    const cleaned = list.map((e) => ({ name: (e.name || '').trim() || '未命名', url: normalizeUrl(e.url) })).filter((e) => e.url)
    const finalList = cleaned.length ? cleaned : DEFAULT_ENVS
    setEnvs(finalList)
    localStorage.setItem(LS_ENVS, JSON.stringify(finalList))
    const idx = Math.min(Math.max(0, selectIdx ?? curIdx), finalList.length - 1)
    setCurIdx(idx)
    localStorage.setItem(LS_ENV_IDX, String(idx))
  }

  const preview = useMemo(() => segPreview(seg.cidr, seg.targets.filter((t) => t.trim()).length), [seg.cidr, seg.targets])

  // 只保存当前选中分类（互斥）：mode = 'segment' | 'random' | 'region'；清空时传 ''
  const persist = async (segG, ranG, regRowsG, modeG) => {
    const rules = []
    if (modeG === 'segment' && segG.targets.some((t) => t.trim())) {
      rules.push({ ...(segG.raw || {}), type: 'segment', id: segG.id || undefined, host: segG.host.trim(), ip_cidr: segG.cidr.trim(), targets: segG.targets, enable: segG.enable, remark: segG.remark })
    }
    if (modeG === 'random' && ranG.targets.some((t) => t.trim())) {
      rules.push({ ...(ranG.raw || {}), type: 'random', id: ranG.id || undefined, host: ranG.host.trim(), ip_cidr: '0.0.0.0/0', targets: ranG.targets, weights: ranG.weights || [], enable: ranG.enable, remark: ranG.remark })
    }
    if (modeG === 'region') {
      for (const row of regRowsG) {
        if (row.kw.trim() && row.target.trim()) {
          rules.push({ type: 'region', host: '', country: row.kw.trim(), target: row.target.trim(), enable: true })
        }
      }
    }
    const res = await apiFetch('/admin/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_target: defaultTarget, rules }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.msg || `HTTP ${res.status}`)
    return data
  }

  const save = async () => {
    setMsg(null)
    setSaving(true)
    try {
      const data = await persist(seg, ran, regRows, mode)
      const redisNote = data.redis === 'ok' ? 'Redis 已写入' : `Redis 未写入（${data.redis}）`
      setMsg({ type: 'ok', text: `【${cur?.name}】已保存并热生效：启用「${MODE_NAME[mode]}」，共 ${data.rules} 条规则；${redisNote}` })
      setTests({})
      await load()
    } catch (e) {
      setMsg({ type: 'err', text: '保存失败：' + e.message })
    } finally {
      setSaving(false)
    }
  }

  const reload = async () => {
    setMsg(null)
    try {
      const res = await apiFetch('/admin/reload', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.msg || `HTTP ${res.status}`)
      setMsg({ type: 'ok', text: `【${cur?.name}】` + data.msg })
      setTests({})
      await load()
    } catch (e) {
      setMsg({ type: 'err', text: '重载失败：' + e.message })
    }
  }

  const resetStats = async () => {
    if (!window.confirm('确定清零当前环境的流量统计？此操作不可恢复。')) return
    try {
      await apiFetch('/admin/stats/reset', { method: 'POST' })
      setStats(null)
      loadStats()
    } catch (e) {
      setMsg({ type: 'err', text: '清零失败：' + e.message })
    }
  }

  // ===== 演示 =====
  const runDemo = async (m) => {
    setDemoRunning(true)
    setDemoRows([])
    const rows = []
    try {
      for (const ip of DEMO[m].cases) {
        const res = await apiFetch('/admin/test?ip=' + encodeURIComponent(ip))
        const d = await res.json()
        if (!res.ok) throw new Error(d.msg || `HTTP ${res.status}`)
        rows.push({ ip, target: d.target, detail: d.detail, matched: d.matched_rule >= 0 })
        setDemoRows([...rows])
      }
    } catch (e) {
      setMsg({ type: 'err', text: '演示失败：' + e.message })
    } finally {
      setDemoRunning(false)
    }
  }

  const importDemo = async (m) => {
    if (!window.confirm(`将导入「${MODE_NAME[m]}」的示例配置并覆盖当前规则（导入后可再修改），继续？`)) return
    setMsg(null)
    setSaving(true)
    try {
      const segG = m === 'segment' ? { ...seg, ...DEMO.segment.group } : { ...seg, targets: [''] }
      const ranG = m === 'random' ? { ...ran, ...DEMO.random.group } : { ...ran, targets: [''] }
      const regG = m === 'region' ? DEMO.region.rows : regRows
      const data = await persist(segG, ranG, regG, m)
      setMode(m)
      const redisNote = data.redis === 'ok' ? 'Redis 已写入' : `Redis 未写入（${data.redis}）`
      setMsg({ type: 'ok', text: `【${cur?.name}】示例配置已导入并热生效；${redisNote}` })
      await load()
      await runDemo(m)
    } catch (e) {
      setMsg({ type: 'err', text: '导入失败：' + e.message })
    } finally {
      setSaving(false)
    }
  }

  const clearAll = async () => {
    if (!window.confirm('清空后所有分类都停用，所有访问都会跳「默认跳转目标」，确定？')) return
    setMsg(null)
    setSaving(true)
    try {
      await persist(seg, ran, [], '')
      setDemoRows(null)
      setMsg({ type: 'ok', text: `【${cur?.name}】已清空，所有访问将跳默认目标。` })
      await load()
    } catch (e) {
      setMsg({ type: 'err', text: '清空失败：' + e.message })
    } finally {
      setSaving(false)
    }
  }

  // 生成演示流量：走真实匹配并计入统计（count=1）
  const genDemoTraffic = async () => {
    const total = 60
    const rnd = (n) => Math.floor(Math.random() * n)
    setDemoTraffic({ sent: 0, total })
    for (let i = 0; i < total; i++) {
      let ip
      if (mode === 'region') {
        // 区域演示：使用已校准归属地的 IP 池
        ip = REGION_DEMO_IPS[i % REGION_DEMO_IPS.length]
      } else if (Math.random() < 0.5) {
        ip = `10.${rnd(256)}.${rnd(256)}.${rnd(254) + 1}`
      } else {
        ip = `${rnd(200) + 20}.${rnd(256)}.${rnd(256)}.${rnd(254) + 1}`
      }
      try {
        await apiFetch(`/admin/go?ip=${ip}&count=1`, { redirect: 'manual' })
      } catch { /* 忽略单次失败 */ }
      setDemoTraffic({ sent: i + 1, total })
    }
    loadStats()
  }

  // ===== 单分类测试 =====
  const ruleIdOf = (key) => (key === 'random' ? ran.id : seg.id)
  const defaultIpOf = (key) => (key === 'random' ? '8.8.8.8' : guessIP(seg.cidr) || '10.0.0.1')
  const testIp = (key) => (tests[key]?.ip ?? '').trim() || defaultIpOf(key)
  const setTestIp = (key, v) => setTests({ ...tests, [key]: { ...(tests[key] || {}), ip: v } })

  const doTest = async (key) => {
    const ip = testIp(key)
    const id = ruleIdOf(key)
    const q = id ? `&rule=${encodeURIComponent(id)}` : ''
    setTests({ ...tests, [key]: { ...(tests[key] || {}), ip, res: null, err: null } })
    try {
      const res = await apiFetch('/admin/test?ip=' + encodeURIComponent(ip) + q)
      const d = await res.json()
      if (!res.ok) throw new Error(d.msg || `HTTP ${res.status}`)
      setTests({ ...tests, [key]: { ip, res: d, err: null } })
    } catch (e) {
      setTests({ ...tests, [key]: { ip, res: null, err: e.message } })
    }
  }
  const goUrl = (key) => {
    const id = ruleIdOf(key)
    if (!id || !baseUrl) return ''
    return `${baseUrl}/admin/go?rule=${encodeURIComponent(id)}&ip=${encodeURIComponent(testIp(key))}`
  }

  // ===== 域名列表编辑 =====
  const setTargets = (key, targets) => {
    if (key === 'random') {
      // 保持权重数组与域名对齐
      const w = [...(ran.weights || [])]
      while (w.length < targets.length) w.push(0)
      w.length = targets.length
      setRan({ ...ran, targets, weights: w })
    } else {
      setSeg({ ...seg, targets })
    }
  }
  const setWeight = (j, v) => {
    const w = [...(ran.weights || [])]
    w[j] = Math.max(0, Number(v) || 0)
    setRan({ ...ran, weights: w })
  }
  const groups = { random: ran, segment: seg }
  const setGroup = (key, patch) => (key === 'random' ? setRan({ ...ran, ...patch }) : setSeg({ ...seg, ...patch }))

  // 分类2：改段数 → 自动生成默认域名配置（保留已填的，缺的补默认值）
  const setSegmentCount = (raw) => {
    const n = Math.max(1, Math.min(50, Number(raw) || 1))
    const cur2 = seg.targets
    const next = Array.from({ length: n }, (_, i) => (cur2[i] && cur2[i].trim() ? cur2[i] : `https://s${i + 1}.example.com`))
    setGroup('segment', { targets: next })
  }

  const targetsEditor = (key, ordered) => {
    const g = groups[key]
    const wSum = (g.weights || []).reduce((a, b) => a + (Number(b) > 0 ? Number(b) : 0), 0)
    return (
      <div className="targets-box">
        {g.targets.map((t, j) => (
          <div className="target-row" key={j}>
            <span className="target-no">{j + 1}</span>
            <input
              className="grow"
              value={t}
              onChange={(e) => setTargets(key, g.targets.map((x, i) => (i === j ? e.target.value : x)))}
              placeholder={`https://${key === 'random' ? 'r' : 's'}${j + 1}.example.com`}
            />
            {!ordered && (
              <>
                <input
                  className="weight-input"
                  type="number"
                  min="0"
                  value={g.weights?.[j] ?? 0}
                  onChange={(e) => setWeight(j, e.target.value)}
                  title="权重：留空或 0 = 平均分配"
                />
                {wSum > 0 && (
                  <span className="weight-pct">
                    {Math.round(((Number(g.weights[j]) > 0 ? Number(g.weights[j]) : 0) / wSum) * 100)}%
                  </span>
                )}
                <button
                  className="btn-mini"
                  disabled={g.targets.length <= 1}
                  onClick={() => setTargets(key, g.targets.filter((_, i) => i !== j))}
                >
                  删除
                </button>
              </>
            )}
          </div>
        ))}
        {!ordered && (
          <>
            <button className="btn" onClick={() => setTargets(key, [...g.targets, ''])}>
              + 添加域名
            </button>
            <span className="hint">
              权重：全为 0/留空 = 平均分配；设置如 50/30/20 即按 50%/30%/20% 切分流量，同一 IP 仍永远固定同一个域名
            </span>
          </>
        )}
        {ordered && <span className="hint">域名顺序 = 段顺序：第 1 个域名拿第 1 段 IP。保存后不要调整顺序，否则 IP 分配会变</span>}
        {ordered && preview && (
          <table className="seg-preview">
            <thead>
              <tr>
                <th>段</th>
                <th>IP 范围（自动均分）</th>
                <th>跳转到</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((p) => (
                <tr key={p.no}>
                  <td>第 {p.no} 段</td>
                  <td className="mono">
                    {p.start} ~ {p.end}
                  </td>
                  <td>
                    第 {p.no} 个域名（{p.no <= g.targets.length && g.targets[p.no - 1]?.trim() ? g.targets[p.no - 1] : '未填'}）
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {ordered && !preview && seg.cidr?.trim() && <span className="hint">网段格式不对，分段预览不可用（支持 IPv4：1.2.3.4 或 1.2.3.0/24）</span>}
      </div>
    )
  }

  const testBox = (key) => {
    const t = tests[key] || {}
    const url = goUrl(key)
    return (
      <div className="rule-body rule-test">
        <span className="field-label">测试</span>
        <div className="test-box">
          <div className="test-line">
            <input
              className="mid"
              value={t.ip ?? ''}
              onChange={(e) => setTestIp(key, e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doTest(key)}
              placeholder={`测试 IP，默认 ${defaultIpOf(key)}`}
            />
            <button className="btn" onClick={() => doTest(key)}>
              查看分配结果
            </button>
            {url ? (
              <a className="btn btn-link" href={url} target="_blank" rel="noreferrer">
                浏览器打开真实跳转
              </a>
            ) : (
              <button className="btn" disabled>
                保存后可真实跳转
              </button>
            )}
          </div>
          {t.err && <div className="test-result msg-err">{t.err}</div>}
          {t.res && (
            <div className="test-result">
              IP <b>{t.res.ip}</b> → 固定到 <b>{t.res.target || '（无）'}</b>
              {t.res.detail && <div className="test-detail">{t.res.detail}；这个 IP 以后永远固定这个域名</div>}
            </div>
          )}
        </div>
      </div>
    )
  }

  // 分类3 区域分流测试：走整链匹配（无需规则 ID）
  const regionTestBox = () => {
    const t = tests['region'] || {}
    const ip = (t.ip ?? '').trim() || '14.215.177.39'
    const doIt = async () => {
      setTests({ ...tests, region: { ...t, ip, res: null, err: null } })
      try {
        const res = await apiFetch('/admin/test?ip=' + encodeURIComponent(ip))
        const d = await res.json()
        if (!res.ok) throw new Error(d.msg || `HTTP ${res.status}`)
        setTests({ ...tests, region: { ip, res: d, err: null } })
      } catch (e) {
        setTests({ ...tests, region: { ip, res: null, err: e.message } })
      }
    }
    return (
      <div className="rule-body rule-test">
        <span className="field-label">测试</span>
        <div className="test-box">
          <div className="test-line">
            <input
              className="mid"
              value={t.ip ?? ''}
              onChange={(e) => setTests({ ...tests, region: { ...t, ip: e.target.value } })}
              onKeyDown={(e) => e.key === 'Enter' && doIt()}
              placeholder="测试 IP，默认 14.215.177.39（广东）"
            />
            <button className="btn" onClick={doIt}>
              查看分配结果
            </button>
            {baseUrl && (
              <a className="btn btn-link" href={`${baseUrl}/admin/go?ip=${encodeURIComponent(ip)}`} target="_blank" rel="noreferrer">
                浏览器打开真实跳转
              </a>
            )}
          </div>
          {t.err && <div className="test-result msg-err">{t.err}</div>}
          {t.res && (
            <div className="test-result">
              IP <b>{t.res.ip}</b> → <b>{t.res.target || '（无）'}</b>
              {t.res.detail && <div className="test-detail">{t.res.detail}</div>}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="header">
        <h1>IP 分流网关管理</h1>
        <div className="env-bar">
          <select className="env-select" value={curIdx} onChange={(e) => switchEnv(Number(e.target.value))}>
            {envs.map((e, i) => (
              <option key={i} value={i}>
                {e.name}（{e.url}）
              </option>
            ))}
          </select>
          <span className={`dot ${health ? (health.ok ? 'dot-ok' : 'dot-bad') : 'dot-unknown'}`} />
          <button className="btn" onClick={checkHealth}>
            测试连接
          </button>
          <button className="btn" onClick={() => setEnvEditorOpen(!envEditorOpen)}>
            管理环境
          </button>
        </div>
      </header>

      <div className={`env-status ${health ? (health.ok ? 'env-ok' : 'env-bad') : ''}`}>
        {health
          ? health.ok
            ? `已连接 ${baseUrl} · 规则 ${health.data.rules} 条 · 来源 ${SOURCE_TEXT[health.data.source] || health.data.source} · 监听 ${health.data.listen}`
            : `连接失败 ${baseUrl}（${health.err}）`
          : `正在连接 ${baseUrl} ...`}
      </div>

      {envEditorOpen && (
        <EnvEditor
          envs={envs}
          curIdx={curIdx}
          onSave={(list, idx) => {
            saveEnvs(list, idx)
            setEnvEditorOpen(false)
            setMsg({ type: 'ok', text: '环境列表已保存到浏览器' })
          }}
          onCancel={() => setEnvEditorOpen(false)}
        />
      )}

      <nav className="tabs page-tabs">
        <button className={`tab ${page === 'config' ? 'active' : ''}`} onClick={() => setPage('config')}>
          规则配置
        </button>
        <button className={`tab ${page === 'demo' ? 'active' : ''}`} onClick={() => setPage('demo')}>
          Demo 预览
        </button>
      </nav>

      {msg && <div className={`msg msg-${msg.type}`}>{msg.text}</div>}

      {page === 'config' && (
        <>
          <section className="card intro">
            <div>
              <b>三个分类互斥，只能启用一个：</b>
              <b>分类1 · 随机分配</b>——只管添加域名，系统自动把每个来访 IP 分到其中一个域名，<b>同一个 IP 永远固定同一个域名</b>（支持权重）；
              <b>分类2 · IP 分段</b>——选<b>分几段</b>，系统自动生成默认域名配置并平均切分 IP 段；
              <b>分类3 · 区域分流</b>——按 IP 归属地（国家/省/市/运营商）关键词跳转。
            </div>
            <div>
              点分类标签 = 选中该分类（显示<b>生效中</b>徽标的才是当前正在跑的），改完点「保存并热生效」。想先看效果？去 <b>Demo 预览</b> 页一键导入示例。
            </div>
          </section>

          <section className="card">
            <div className="tabs">
              {['random', 'segment', 'region'].map((k) => (
                <button key={k} className={`tab ${mode === k ? 'active' : ''}`} onClick={() => setMode(k)}>
                  {MODE_NAME[k]}
                  {effectiveMode === k && <span className="live-badge">生效中</span>}
                </button>
              ))}
              {effectiveMode === '' && <span className="hint" style={{ alignSelf: 'center', marginLeft: 8 }}>当前未启用任何分类</span>}
            </div>
            {effectiveMode && mode !== effectiveMode && (
              <div className="hint mode-switch-hint">
                当前生效的是「{MODE_NAME[effectiveMode]}」；保存后将切换为「{MODE_NAME[mode]}」，另一分类的规则会被停用。
              </div>
            )}

            {mode === 'random' && (
              <div className="group">
                <div className="rule-body">
                  <span className="field-label">启用</span>
                  <label className="enable-label">
                    <input type="checkbox" checked={ran.enable} onChange={(e) => setGroup('random', { enable: e.target.checked })} />
                    开启后所有来访 IP 自动分配到下面的域名
                  </label>
                </div>
                <div className="rule-body">
                  <span className="field-label">接入域名</span>
                  <input
                    className="grow mono"
                    value={ran.host}
                    onChange={(e) => setGroup('random', { host: e.target.value })}
                    placeholder="留空 = 所有域名；支持 *.example.com 通配"
                  />
                </div>
                <div className="rule-body">
                  <span className="field-label">域名列表</span>
                  {targetsEditor('random', false)}
                </div>
                <div className="rule-body">
                  <span className="field-label">备注</span>
                  <input className="grow" value={ran.remark} onChange={(e) => setGroup('random', { remark: e.target.value })} placeholder="备注（可选）" />
                </div>
                {testBox('random')}
              </div>
            )}

            {mode === 'segment' && (
              <div className="group">
                <div className="rule-body">
                  <span className="field-label">启用</span>
                  <label className="enable-label">
                    <input type="checkbox" checked={seg.enable} onChange={(e) => setGroup('segment', { enable: e.target.checked })} />
                    开启后按下面的网段自动分段
                  </label>
                </div>
                <div className="rule-body">
                  <span className="field-label">接入域名</span>
                  <input
                    className="grow mono"
                    value={seg.host}
                    onChange={(e) => setGroup('segment', { host: e.target.value })}
                    placeholder="留空 = 所有域名；支持 *.example.com 通配"
                  />
                </div>
                <div className="rule-body">
                  <span className="field-label">分几段</span>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    className="count-input"
                    value={seg.targets.length}
                    onChange={(e) => setSegmentCount(e.target.value)}
                  />
                  <span className="hint">选段数后自动生成默认域名，改成你的域名即可（1~50 段）</span>
                </div>
                <div className="rule-body">
                  <span className="field-label">IP 段</span>
                  <input
                    className="mid mono"
                    value={seg.cidr}
                    onChange={(e) => setGroup('segment', { cidr: e.target.value })}
                    placeholder="如 10.0.0.0/8（也支持单 IP）"
                  />
                </div>
                <div className="rule-body">
                  <span className="field-label">域名列表</span>
                  {targetsEditor('segment', true)}
                </div>
                <div className="rule-body">
                  <span className="field-label">备注</span>
                  <input className="grow" value={seg.remark} onChange={(e) => setGroup('segment', { remark: e.target.value })} placeholder="备注（可选）" />
                </div>
                {testBox('segment')}
              </div>
            )}

            {mode === 'region' && (
              <div className="group">
                {health?.ok && health.data.geo === false && (
                  <div className="msg msg-err" style={{ marginBottom: 10 }}>
                    当前网关未加载 IP 地理库，区域分流不会命中——请更新网关到内嵌地理库的最新版本（doc/04 第 9 节）。
                  </div>
                )}
                <div className="rule-body">
                  <span className="field-label">区域规则</span>
                  <div className="targets-box">
                    {regRows.map((r, j) => (
                      <div className="target-row" key={j}>
                        <input
                          className="kw-input mono"
                          value={r.kw}
                          onChange={(e) => setRegRows(regRows.map((x, i) => (i === j ? { ...x, kw: e.target.value } : x)))}
                          placeholder="关键词：广东 / 北京 / 电信…"
                        />
                        <span className="arrow">→</span>
                        <input
                          className="grow mono"
                          value={r.target}
                          onChange={(e) => setRegRows(regRows.map((x, i) => (i === j ? { ...x, target: e.target.value } : x)))}
                          placeholder="https://gd.example.com"
                        />
                        <button
                          className="btn-mini"
                          disabled={regRows.length <= 1}
                          onClick={() => setRegRows(regRows.filter((_, i) => i !== j))}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                    <button className="btn" onClick={() => setRegRows([...regRows, { kw: '', target: '' }])}>
                      + 添加区域
                    </button>
                    <span className="hint">
                      关键词匹配 IP 归属地（国家/省份/城市/运营商，如「广东」「北京」「电信」「美国」），从上到下命中第一条；未命中任何区域跳默认目标。演示 IP 已校准：14.215.177.39=广东、61.135.169.121=北京、8.8.8.8=美国。
                    </span>
                  </div>
                </div>
                {regionTestBox()}
              </div>
            )}
          </section>

          <section className="card">
            <div className="row">
              <label>默认跳转目标（不属于任何分类的 IP 跳这里）</label>
              <input
                className="wide"
                value={defaultTarget}
                onChange={(e) => setDefaultTarget(e.target.value)}
                placeholder="https://default.example.com"
              />
            </div>
          </section>

          <section className="card actions">
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? '保存中…' : `保存并热生效（启用${MODE_NAME[mode] || '分类'}）`}
            </button>
            <button className="btn" onClick={reload}>
              重载配置（Redis 优先 → 文件兜底）
            </button>
          </section>

          <section className="card stats-card">
            <div className="stats-head">
              <h2>流量统计</h2>
              <div className="row">
                <span className="hint">
                  仅统计真实访问（测试通道不计）{stats ? ` · 自 ${stats.since} 起累计 ${stats.total} 次` : ''}
                </span>
                <button className="btn" onClick={loadStats}>
                  刷新
                </button>
                <button className="btn btn-danger-ghost" onClick={resetStats}>
                  清零
                </button>
              </div>
            </div>
            <StatsView stats={stats} />
            <div className="hint" style={{ marginTop: 8 }}>
              想看图表效果但没有真实流量？去 <b>Demo 预览</b> 页点「生成演示流量」。
            </div>
          </section>
        </>
      )}

      {page === 'demo' && (
        <>
          <section className="card">
            <h2>第一步：导入示例配置（互斥，导入哪个就启用哪个）</h2>
            <div className="demo-btns">
              <button className="btn btn-primary" onClick={() => importDemo('random')} disabled={saving || demoRunning}>
                导入示例：分类1 · 随机分配
              </button>
              <button className="btn btn-primary" onClick={() => importDemo('segment')} disabled={saving || demoRunning}>
                导入示例：分类2 · IP 分段
              </button>
              <button className="btn btn-primary" onClick={() => importDemo('region')} disabled={saving || demoRunning}>
                导入示例：分类3 · 区域分流
              </button>
              <button className="btn btn-danger-ghost" onClick={clearAll} disabled={saving || demoRunning}>
                清空配置（全部停用）
              </button>
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              导入会覆盖当前规则并立即热生效（导入后可去「规则配置」页改成你的域名）。清空后所有访问跳默认目标。
            </div>
          </section>

          <section className="card">
            <h2>第二步：效果预览（模拟匹配）</h2>
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="btn" onClick={() => mode && runDemo(mode)} disabled={demoRunning || !mode}>
                {demoRunning ? '演示运行中…' : `重新运行演示（${MODE_NAME[mode] || '未选分类'}）`}
              </button>
            </div>
            {demoRows && demoRows.length > 0 ? (
              <table className="demo-table">
                <thead>
                  <tr>
                    <th>测试 IP</th>
                    <th>命中情况</th>
                    <th>跳转到</th>
                    <th>说明</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {demoRows.map((r) => (
                    <tr key={r.ip}>
                      <td className="mono">{r.ip}</td>
                      <td>{r.matched ? '命中规则' : '默认目标'}</td>
                      <td className="mono">
                        <b>{r.target}</b>
                      </td>
                      <td className="hint">{r.detail}</td>
                      <td>
                        <a className="btn btn-link" href={`${baseUrl}/admin/go?ip=${encodeURIComponent(r.ip)}`} target="_blank" rel="noreferrer">
                          真实跳转
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty">先导入示例配置，再点「重新运行演示」查看每个 IP 落到哪个域名</div>
            )}
          </section>

          <section className="card">
            <h2>第三步：流量统计演示</h2>
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="btn btn-primary" onClick={genDemoTraffic} disabled={demoTraffic && demoTraffic.sent < demoTraffic.total}>
                {demoTraffic && demoTraffic.sent < demoTraffic.total
                  ? `生成中 ${demoTraffic.sent}/${demoTraffic.total}`
                  : '生成演示流量（60 次模拟访问）'}
              </button>
              <button className="btn" onClick={loadStats}>
                刷新统计
              </button>
              <button className="btn btn-danger-ghost" onClick={resetStats}>
                清零统计
              </button>
            </div>
            <div className="hint" style={{ marginBottom: 8 }}>
              点按钮后网关会真实处理 40 次模拟跳转（计入统计），下方图表立即有数据。
            </div>
            <StatsView stats={stats} />
          </section>
        </>
      )}

      <footer className="footer">本地管理后台 · 环境配置保存在浏览器 localStorage · 不随网关部署</footer>
    </div>
  )
}

// ===== 统计图表（配置页与 Demo 页共用） =====
function StatsView({ stats }) {
  if (!stats || !stats.targets || stats.targets.length === 0) {
    return <div className="empty">暂无访问数据</div>
  }
  const maxT = Math.max(...stats.targets.map((x) => x.count), 1)
  const hasHourly = stats.hourly && stats.hourly.some((h) => h.total > 0)
  return (
    <>
      <div className="stat-bars">
        {stats.targets.map((t) => (
          <div className="stat-row" key={t.target}>
            <span className="stat-name mono">{t.target}</span>
            <div className="stat-track">
              <div className="stat-fill" style={{ width: `${(t.count / maxT) * 100}%` }} />
            </div>
            <span className="stat-num">{t.count}</span>
          </div>
        ))}
      </div>
      {hasHourly && (
        <>
          <div className="hint" style={{ marginTop: 12 }}>
            最近 24 小时分布
          </div>
          <div className="hour-bars">
            {stats.hourly.map((h) => {
              const maxH = Math.max(...stats.hourly.map((x) => x.total), 1)
              return (
                <div key={h.label} className="hour-col" title={`${h.label}：${h.total} 次`}>
                  <div className="hour-fill" style={{ height: `${(h.total / maxH) * 100}%` }} />
                  <span className="hour-label">{h.label.slice(-3)}</span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}

// ===== 环境编辑器 =====
function EnvEditor({ envs, curIdx, onSave, onCancel }) {
  const [list, setList] = useState(envs.map((e) => ({ ...e })))
  const [err, setErr] = useState('')

  const update = (i, key, v) => setList(list.map((e, j) => (j === i ? { ...e, [key]: v } : e)))
  const add = () => setList([...list, { name: '', url: '' }])
  const remove = (i) => setList(list.filter((_, j) => j !== i))

  const submit = () => {
    const valid = list.filter((e) => normalizeUrl(e.url))
    if (!valid.length) {
      setErr('至少需要一个有效的接口地址')
      return
    }
    onSave(valid, curIdx)
  }

  return (
    <section className="card env-editor">
      <h2>管理环境（保存在本浏览器）</h2>
      {list.map((e, i) => (
        <div className="env-row" key={i}>
          <input className="env-name" value={e.name} onChange={(ev) => update(i, 'name', ev.target.value)} placeholder="名称，如：线上" />
          <input
            className="grow mono"
            value={e.url}
            onChange={(ev) => update(i, 'url', ev.target.value)}
            placeholder="接口地址，如 https://golang-ip-gateway.98maihua.com（粘贴 .../healthz 也可以）"
          />
          <button className="btn-mini" disabled={list.length <= 1} onClick={() => remove(i)}>
            删除
          </button>
          {i === curIdx && <span className="env-cur">当前</span>}
        </div>
      ))}
      {err && <div className="msg msg-err">{err}</div>}
      <div className="toolbar">
        <button className="btn" onClick={add}>
          + 添加环境
        </button>
        <span className="hint">网关需为支持 CORS 的版本；地址可直接粘贴带 /healthz 的完整地址，会自动去掉尾巴</span>
      </div>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={submit}>
          保存环境列表
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  )
}
