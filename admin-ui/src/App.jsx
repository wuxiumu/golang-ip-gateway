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

  // ===== 规则数据（属于当前环境） =====
  const [defaultTarget, setDefaultTarget] = useState('')
  const [source, setSource] = useState('')
  const [msg, setMsg] = useState(null)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('random')
  const [ran, setRan] = useState({ id: '', raw: null, targets: [], enable: true, remark: '' })
  const [seg, setSeg] = useState({ id: '', raw: null, cidr: '', targets: [], enable: true, remark: '' })
  const [tests, setTests] = useState({})

  // 所有接口都打到当前选中环境
  const apiFetch = useCallback(
    (path, opts) => fetch(baseUrl + path, opts),
    [baseUrl],
  )

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
    setSeg(
      segR
        ? { id: segR.id || '', raw: segR, cidr: segR.ip_cidr || '', targets: segR.targets || [], enable: !!segR.enable, remark: segR.remark || '' }
        : { id: '', raw: null, cidr: '10.0.0.0/8', targets: ['https://s1.example.com', 'https://s2.example.com', 'https://s3.example.com'], enable: true, remark: '' },
    )
    setRan(
      ranR
        ? { id: ranR.id || '', raw: ranR, targets: ranR.targets || [], enable: !!ranR.enable, remark: ranR.remark || '' }
        : { id: '', raw: null, targets: [''], enable: true, remark: '' },
    )
    await checkHealth()
  }, [apiFetch, checkHealth])

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

  const save = async () => {
    setMsg(null)
    setSaving(true)
    try {
      const rules = []
      // 分段规则放前面（先匹配），随机分配兜底放最后
      if (seg.targets.some((t) => t.trim())) {
        rules.push({ ...(seg.raw || {}), type: 'segment', id: seg.id || undefined, ip_cidr: seg.cidr.trim(), targets: seg.targets, enable: seg.enable, remark: seg.remark })
      }
      if (ran.targets.some((t) => t.trim())) {
        rules.push({ ...(ran.raw || {}), type: 'random', id: ran.id || undefined, ip_cidr: '0.0.0.0/0', targets: ran.targets, enable: ran.enable, remark: ran.remark })
      }
      const res = await apiFetch('/admin/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_target: defaultTarget, rules }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.msg || `HTTP ${res.status}`)
      const redisNote = data.redis === 'ok' ? 'Redis 已写入' : `Redis 未写入（${data.redis}）`
      setMsg({ type: 'ok', text: `【${cur?.name}】已保存并热生效，共 ${data.rules} 条规则；${redisNote}` })
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
  const setTargets = (key, targets) => (key === 'random' ? setRan({ ...ran, targets }) : setSeg({ ...seg, targets }))
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
              <button
                className="btn-mini"
                disabled={g.targets.length <= 1}
                onClick={() => setTargets(key, g.targets.filter((_, i) => i !== j))}
              >
                删除
              </button>
            )}
          </div>
        ))}
        {!ordered && (
          <button className="btn" onClick={() => setTargets(key, [...g.targets, ''])}>
            + 添加域名
          </button>
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

      {msg && <div className={`msg msg-${msg.type}`}>{msg.text}</div>}

      <section className="card intro">
        <div>
          <b>分类1 · 随机分配：</b>只管添加域名，系统自动把每个来访 IP 分到其中一个域名，<b>同一个 IP 永远固定同一个域名</b>。
        </div>
        <div>
          <b>分类2 · IP 分段：</b>选<b>分几段</b>，系统自动生成默认域名配置并平均切分 IP 段；把默认域名改成你的即可，第 1 段 IP → 第 1 个域名。
        </div>
      </section>

      <section className="card">
        <div className="tabs">
          <button className={`tab ${tab === 'random' ? 'active' : ''}`} onClick={() => setTab('random')}>
            分类1 · 随机分配
          </button>
          <button className={`tab ${tab === 'segment' ? 'active' : ''}`} onClick={() => setTab('segment')}>
            分类2 · IP 分段
          </button>
        </div>

        {tab === 'random' && (
          <div className="group">
            <div className="rule-body">
              <span className="field-label">启用</span>
              <label className="enable-label">
                <input type="checkbox" checked={ran.enable} onChange={(e) => setGroup('random', { enable: e.target.checked })} />
                开启后所有来访 IP 自动分配到下面的域名
              </label>
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

        {tab === 'segment' && (
          <div className="group">
            <div className="rule-body">
              <span className="field-label">启用</span>
              <label className="enable-label">
                <input type="checkbox" checked={seg.enable} onChange={(e) => setGroup('segment', { enable: e.target.checked })} />
                开启后按下面的网段自动分段
              </label>
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
          {saving ? '保存中…' : `保存并热生效（${cur?.name}）`}
        </button>
        <button className="btn" onClick={reload}>
          重载配置（Redis 优先 → 文件兜底）
        </button>
      </section>

      <footer className="footer">本地管理后台 · 环境配置保存在浏览器 localStorage · 不随网关部署</footer>
    </div>
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
