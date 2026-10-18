// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ review: null }))
vi.mock('../components/IntervalsSync.jsx', () => ({
  // Isolate the integration panel while exercising the callback supplied by Settings.
  default: ({ onReview }) => { mocks.review = onReview; return <div>Intervals.icu</div> },
}))
vi.mock('../store/useStore.js', () => {
  const snapshot = () => ({
    S: { unit: 'kg', restSec: 90, sound: false, workouts: [], routines: [], exWeights: {} },
    user: { id: 'u1', name: 'andi' },
    update: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(), resetDemo: vi.fn(),
  })
  const useStore = selector => selector ? selector(snapshot()) : snapshot()
  useStore.getState = snapshot
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snapshot = () => ({ toast: vi.fn(), openSheet: vi.fn() })
  const useUI = selector => selector ? selector(snapshot()) : snapshot()
  useUI.getState = snapshot
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  api: vi.fn(), webauthnOK: () => false, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), IS_ANDROID: false,
}))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), syncReminder: vi.fn() }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: vi.fn(), importFromApp: vi.fn(), importFromHevy: vi.fn(),
  equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(),
}))

let host, root
beforeEach(() => {
  mocks.review = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

function RoutineEditorRoute() {
  const { id } = useParams()
  return <div data-routine-editor={id}>Routine editor</div>
}

it('opens the imported routine editor when Intervals.icu requests Review plan from Settings', async () => {
  await act(async () => root.render(
    <MemoryRouter initialEntries={['/settings/data']}>
      <Routes>
        <Route path="/settings/data" element={<Settings page="data" />} />
        <Route path="/plan/r/:id" element={<RoutineEditorRoute />} />
      </Routes>
    </MemoryRouter>
  ))
  expect(host.textContent).toContain('Intervals.icu')
  expect(mocks.review).toBeTypeOf('function')

  act(() => mocks.review('imported-routine-42'))

  expect(host.querySelector('[data-routine-editor]')?.dataset.routineEditor).toBe('imported-routine-42')
})
