import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { Section, Row, Switch, Button, TextField } from './ui.jsx'

const initial = () => ({ historyDays: 90, futureDays: 42, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', enabled: true })
const dateText = value => value ? new Date(value).toLocaleString() : t('Never')

export default function IntervalsSync({ user, mobile = false, onPull = async () => {}, onReview }) {
  const [status, setStatus] = useState(null), [form, setForm] = useState(initial)
  const [apiKey, setApiKey] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const lastSync = useRef(null), mounted = useRef(false), pull = useRef(onPull)
  pull.current = onPull
  useEffect(() => {
    if (!user) return
    let live = true, polling = false
    mounted.current = true
    const refresh = async () => {
      if (polling) return
      polling = true
      try {
        const next = await api('/api/intervals/status')
        if (!live) return
        setStatus(next)
        if (lastSync.current === null && next.options) setForm(next.options)
        if (next.lastSync && next.lastSync !== lastSync.current) await pull.current()
        lastSync.current = next.lastSync || 0
      } catch (e) { if (live) setError(e.message) }
      finally { polling = false }
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => { live = false; mounted.current = false; clearInterval(timer) }
  }, [user?.id])

  async function perform(path, method, body) {
    setBusy(true); setError('')
    try {
      const result = await api('/api/intervals/' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}), timeout: 120000 })
      if (mounted.current) {
        if (path === 'oauth/start') { window.location.assign(result.url); return }
        setStatus(previous => ({ ...previous, ...result }))
        if (path === 'connect') setApiKey('')
        await pull.current()
      }
    } catch (e) { if (mounted.current) setError(e.message) }
    finally { if (mounted.current) setBusy(false) }
  }
  const choose = (conflict, choice) => {
    const selected = choice === 'local' ? conflict.local : conflict.remote
    if (!selected) setDeleting({ id: conflict.id, choice, token: conflict.token })
    else perform('resolve', 'POST', { id: conflict.id, choice, token: conflict.token })
  }
  const disabled = busy || status?.running
  const field = (key, value) => setForm(previous => ({ ...previous, [key]: value }))
  if (!user) return <Section title="Intervals.icu"><Row title="Intervals.icu" subtitle={t('Sign in to an OpenGym server to sync workouts, body weight, and planned sessions with Intervals.icu.')} /></Section>

  return <Section title="Intervals.icu" footer={t('Syncs gym workouts, daily body weight, and dated gym plans. The server polls every 15 minutes and after OpenGym changes. Floating rotation sessions need a date pin.')}>
    <Row icon="link" title="Intervals.icu" subtitle={t('Two-way sync')} />
    {error && <div role="alert" style={{ padding: 16, color: 'var(--red)' }}>{error}</div>}
    {!status && !error && <Row title={t('Loading…')} />}
    {status?.connected && <>
      <Row icon="link" title={status.athlete?.name || 'Intervals.icu'} subtitle={status.running ? t('Syncing…') : t('Last sync: {0}', dateText(status.lastSync))} />
      {status.error && <div role="alert" style={{ padding: 16 }}><p>{status.error}</p><p>{t('Next attempt: {0}', dateText(status.nextRun))}</p></div>}
      <Row title={t('Automatic sync')}><Switch aria-label={t('Automatic sync')} checked={form.enabled} disabled={disabled}
        onChange={enabled => { field('enabled', enabled); perform('settings', 'PUT', { ...form, enabled }) }} /></Row>
      <Row title={t('Sync now')} subtitle={t('Uploads and imports within your selected range. Conflicts wait for your choice.')}
        accessory="chevron" onClick={disabled ? undefined : () => perform('sync', 'POST')} />
      <Row title={t('Re-sync existing activities')} subtitle={t('Resends linked workouts in your saved history range to fill missing data, including weight lifted. Conflicts wait for your choice.')}
        accessory="chevron" onClick={disabled ? undefined : () => perform('resync-activities', 'POST')} />
      {status.resyncRemaining > 0 && <Row title={t('Activities left to re-sync: {0}', status.resyncRemaining)} />}
    </>}
    {status && <div style={{ padding: 16, display: 'grid', gap: 12 }}>
      <label>{t('History to sync (days)')}<TextField aria-label={t('History to sync (days)')} type="number" min="1" max="3650" disabled={disabled} value={form.historyDays} onChange={e => field('historyDays', Number(e.target.value))} /></label>
      <label>{t('Planned sessions ahead (days)')}<TextField aria-label={t('Planned sessions ahead (days)')} type="number" min="1" max="180" disabled={disabled} value={form.futureDays} onChange={e => field('futureDays', Number(e.target.value))} /></label>
      <label>{t('Sync timezone')}<TextField aria-label={t('Sync timezone')} value={form.timezone} disabled={disabled} onChange={e => field('timezone', e.target.value)} placeholder="Europe/Zurich" /></label>
      {status.connected ? <Button disabled={disabled} onClick={() => perform('settings', 'PUT', form)}>{t('Save sync settings')}</Button> : <>
        {status.oauthAvailable && !mobile && <Button disabled={disabled} onClick={() => perform('oauth/start', 'POST', form)}>{t('Connect with Intervals.icu')}</Button>}
        {status.oauthAvailable && mobile && <p>{t('For OAuth, connect from OpenGym in your web browser. The connection also serves this phone.')}</p>}
        <label>{t('Personal API key')}<TextField type="password" aria-label={t('Personal API key')} value={apiKey} autoComplete="off" spellCheck={false} onChange={e => setApiKey(e.target.value)} /></label>
        <p>{t('For personal self-hosting, copy your API key from Intervals.icu Settings → Developer settings. Shared installations should use OAuth.')}</p>
        <Button disabled={disabled || !apiKey.trim()} onClick={() => perform('connect', 'POST', { ...form, apiKey })}>{t('Connect with API key')}</Button>
      </>}
    </div>}
    {status?.conflicts?.length > 0 && <div style={{ padding: 16 }}>
      <h3>{t('Sync conflicts')}</h3>
      <p>{t('Compare both versions. Choosing a side replaces the shared fields on the other side. Detailed OpenGym sets are preserved.')}</p>
      {status.conflicts.map(c => <div key={c.id} style={{ borderTop: '1px solid var(--line)', paddingBlock: 16 }}>
        <strong>{c.local?.name || c.remote?.name || c.local?.date || c.remote?.date || c.key}</strong>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBlock: 12 }}>
          {[['OpenGym', c.local], ['Intervals.icu', c.remote]].map(([label, v]) => <div key={label}><strong>{label}</strong><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto' }}>{v ? [v.date, v.time, v.name, v.weight != null ? `${v.weight} kg` : '', v.seconds ? t('{0} minutes', Math.round(v.seconds / 60)) : '', v.description].filter(Boolean).join('\n') : t('Deleted / absent')}</p></div>)}
        </div>
        {c.blocked ? <p>{c.reason === 'occupied-date' ? t('This date already has another OpenGym session. Move a session to a free date before syncing.') : t('Multiple Intervals.icu sessions share a date. Combine or move them in Intervals.icu before syncing this date.')}</p> : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button disabled={disabled} onClick={() => choose(c, 'local')}>{t('Use OpenGym')}</Button>
          <Button disabled={disabled} onClick={() => choose(c, 'remote')}>{t('Use Intervals.icu')}</Button>
        </div>}
      </div>)}
    </div>}
    {deleting && <div role="alertdialog" aria-label={t('Confirm deletion')} style={{ padding: 16 }}>
      <p>{t('Delete this linked record from the other app? This choice propagates the deletion. Other records are kept.')}</p>
      <Button disabled={disabled} onClick={() => { perform('resolve', 'POST', deleting); setDeleting(null) }}>{t('Confirm deletion')}</Button>
      <Button onClick={() => setDeleting(null)}>{t('Cancel')}</Button>
    </div>}
    {status?.reviews?.map(r => <Row key={r.id} title={t('Review plan')} subtitle={r.name + ' — ' + t('Imported plan needs exercises: {0}. Its original description is kept in the routine notes.', r.date)}
      accessory="chevron" onClick={onReview ? () => onReview(r.id) : undefined} />)}
    {status?.connected && <Row title={t('Disconnect Intervals.icu')} subtitle={t('Stops polling and removes stored credentials. Your workouts and plans stay in both apps.')}
      accessory="chevron" onClick={busy ? undefined : () => perform('connect', 'DELETE')} />}
  </Section>
}
