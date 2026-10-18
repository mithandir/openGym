// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, test, expect, vi } from 'vitest'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const m = vi.hoisted(() => ({ status: { connected: false, conflicts: [] }, calls: [] }))
vi.mock('../lib/api.js', () => ({ api: async (url, opts = {}) => {
  m.calls.push([url, opts])
  if (url.endsWith('/connect') && opts.method === 'POST') m.status = { connected: true, options: { historyDays: 90, futureDays: 42, timezone: 'UTC', enabled: true }, conflicts: [], athlete: { name: 'Athlete' } }
  if (opts.method === 'DELETE') m.status = { connected: false, conflicts: [] }
  return m.status
} }))
vi.mock('../lib/i18n.js', () => ({ t: (s, ...args) => s.replace(/\{(\d+)\}/g, (_, n) => args[n] ?? '') }))
const { default: IntervalsSync } = await import('./IntervalsSync.jsx')
let host, root
beforeEach(() => { m.calls = []; m.status = { connected: false, conflicts: [] }; host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const mount = async user => { await act(async () => root.render(<IntervalsSync user={user} onPull={async () => {}} />)) }
const click = async label => { const button = [...host.querySelectorAll('button')].find(b => b.textContent === label); expect(button).toBeTruthy(); await act(async () => button.click()) }
test('guest profiles see a sign-in explanation and make no integration requests', async () => {
  await mount(null); expect(host.textContent).toContain('Sign in'); expect(m.calls.length).toBe(0)
})
test('personal key stays in the request and is cleared after connection', async () => {
  await mount({ id: 'u' })
  const input = host.querySelector('input[type="password"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'secret-key')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Connect with API key')
  expect(m.calls.some(([url, opts]) => url.endsWith('/connect') && JSON.parse(opts.body || '{}').apiKey === 'secret-key')).toBe(true)
  expect(host.querySelector('input[type="password"]')).toBeNull()
  expect(host.textContent).toContain('Athlete')
})
test('deletion choices explain their effect and require confirmation before submission', async () => {
  m.status = { connected: true, athlete: {}, options: {}, conflicts: [{ id: 'activity:w', token: 'reviewed', kind: 'activity', local: null, remote: { name: 'Gym', date: '2026-10-18', description: 'Sets' } }] }
  await mount({ id: 'u' }); await click('Use OpenGym')
  expect(m.calls.some(([url]) => url.endsWith('/resolve'))).toBe(false)
  expect(host.textContent).toContain('Delete this linked record')
  await click('Confirm deletion')
  const call = m.calls.find(([url]) => url.endsWith('/resolve'))
  expect(JSON.parse(call[1].body)).toEqual({ id: 'activity:w', choice: 'local', token: 'reviewed' })
})
test('blocked calendar collisions offer a correction explanation instead of an unsafe overwrite', async () => {
  m.status = { connected: true, athlete: {}, options: {}, conflicts: [{ id: 'plan:d', kind: 'plan', blocked: true, reason: 'Combine or move the sessions', remote: { name: 'Gym' } }] }
  await mount({ id: 'u' }); expect(host.textContent).toContain('Combine or move them')
  expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Use Intervals.icu')).toBe(false)
})

test('deletion confirmation retains the snapshot originally reviewed while status refreshes', async () => {
  vi.useFakeTimers()
  try {
    m.status = { connected: true, athlete: {}, options: {}, conflicts: [{ id: 'activity:w', token: 'original', local: null, remote: { name: 'Original' } }] }
    await mount({ id: 'u' }); await click('Use OpenGym')
    m.status = { ...m.status, conflicts: [{ id: 'activity:w', token: 'updated', local: null, remote: { name: 'Updated' } }] }
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(host.textContent).toContain('Updated')
    await click('Confirm deletion')
    const call = m.calls.find(([url]) => url.endsWith('/resolve'))
    expect(JSON.parse(call[1].body)).toEqual({ id: 'activity:w', choice: 'local', token: 'original' })
  } finally { vi.useRealTimers() }
})

test('ordinary conflict choices submit the displayed snapshot token', async () => {
  m.status = { connected: true, athlete: {}, options: {}, conflicts: [{ id: 'activity:w', token: 'displayed', local: { name: 'Local' }, remote: { name: 'Remote' } }] }
  await mount({ id: 'u' }); await click('Use OpenGym')
  const call = m.calls.find(([url]) => url.endsWith('/resolve'))
  expect(JSON.parse(call[1].body)).toEqual({ id: 'activity:w', choice: 'local', token: 'displayed' })
})

test('connected profiles can re-sync existing activities and see pending progress', async () => {
  m.status = { connected: true, options: {}, conflicts: [], resyncRemaining: 3 }
  await mount({ id: 'u' })
  expect(host.textContent).toContain('Activities left to re-sync: 3')
  const button = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Re-sync existing activities'))
  expect(button).toBeTruthy()
  await act(async () => button.click())
  expect(m.calls.some(([url, opts]) => url.endsWith('/resync-activities') && opts.method === 'POST')).toBe(true)
})

test('re-sync is unavailable while another sync is running', async () => {
  m.status = { connected: true, options: {}, conflicts: [], running: true }
  await mount({ id: 'u' })
  expect([...host.querySelectorAll('button')].some(b => b.textContent.includes('Re-sync existing activities'))).toBe(false)
})
