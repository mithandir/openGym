// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { EXDB, isCardio } from './lib/exercises.js'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { exConfigSheet } from './sheets.jsx'

let root, host
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useUI.setState({ sheets: [] })
  useStore.setState(s => ({ S: { ...s.S, unit: 'kg', lang: 'en' } }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

for (const mode of ['reps', 'time', 'cardio']) {
  it(`keeps dated source lineage and exclusion when saving ${mode} exercise settings`, () => {
    const ex = EXDB.find(e => mode === 'cardio' ? isCardio(e.id) : !isCardio(e.id))
    const onSave = vi.fn()
    const cfg = { sets: 2, reps: 5, weight: 40, sec: 30, min: 20, mode, progressionRoutineId: 'heavy', excludeFromProgression: true }
    exConfigSheet(ex, cfg, onSave)
    const sheet = useUI.getState().sheets.at(-1)
    act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
    act(() => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').click())
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0]).toMatchObject({ progressionRoutineId: 'heavy', excludeFromProgression: true })
  })
}
