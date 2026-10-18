import { describe, it, expect } from 'vitest'
import { applyRecord, localRecords } from '../../../api/intervals-model.js'
import { buildCombinedEntries } from './session-merge.js'
import { buildPlannedEntry, builtOutOfProgression, plannedConfigOf } from './session-start.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { setSessionNoProg } from './session-noprog.js'

const options = { today: '2026-10-18', futureDays: 7, timezone: 'UTC' }
const cfg = { id: '0025', sets: 2, reps: 8, weight: 40 }
const makeState = () => ({
  unit: 'kg', workouts: [], exWeights: {}, dayPlan: {}, week: { 1: ['main', 'rehab'] },
  routines: [
    { id: 'main', name: 'Main', prog: 'double', ex: [{ ...cfg, repsMin: 5 }] },
    { id: 'rehab', name: 'Rehab', prog: 'linear', excludeFromProgression: true, ex: [{ ...cfg, weight: 10 }] },
  ],
})

// Exercise the same imported routine through the live-session builder and persisted boundary.
describe('Intervals dated plan training settings', () => {
  it('preserves mixed policies and exclusions through repeated metadata edits, rebuild, and finish', () => {
    const st = makeState()
    const originals = structuredClone(st.routines)
    const p = localRecords(st, options).find(r => r.kind === 'plan')
    for (const name of ['Edited', 'Edited again']) {
      applyRecord(st, 'plan', p.key, { ...p.value, name }, 100, options)
      const id = st.dayPlan[p.value.date]
      const { entries, routineIds, routines } = buildCombinedEntries(st, [id])
      expect(entries[0].plan.policy).toBe('double')
      expect(entries[0].noProg).toBeUndefined()
      expect(entries[1].plan.kind).toBe('off')
      expect(entries[1].noProg).toBe(true)
      expect(entries[1].sets.map(s => s.w)).toEqual([10, 10])
      expect(builtOutOfProgression(entries[1], routines[0])).toBe(true)
      expect(builtOutOfProgression({ ...entries[0], noProg: true }, routines[0])).toBe(false)
      const rebuilt = buildPlannedEntry(st, plannedConfigOf(entries[1]), routines[0], { noProg: builtOutOfProgression(entries[1], routines[0]) })
      expect(rebuilt.plan.kind).toBe('off')
      expect(rebuilt.sets.map(s => s.w)).toEqual([10, 10])
      // The header and exercise menu use this same predicate to keep plan exclusions locked.
      const keepsOut = e => builtOutOfProgression(e, routines[0])
      expect(entries.map(keepsOut)).toEqual([false, true])
      const active = { entries }
      setSessionNoProg(active, true, keepsOut)
      setSessionNoProg(active, false, keepsOut)
      expect(entries.map(e => e.noProg)).toEqual([undefined, true])
      const finished = buildCompletedWorkout({ id: 'w', d: p.value.date, routineIds, entries: entries.map(e => ({ ...e, sets: e.sets.map(s => ({ ...s, done: true })) })) })
      expect(finished.entries.map(e => e.noProg)).toEqual([undefined, true])
      expect(finished.excludeFromProgression).toBeUndefined()
      expect(st.routines.slice(0, 2)).toEqual(originals)
    }
  })
})

it('keeps an added or swapped exercise in an excluded copied block locked on later rebuilds', () => {
  const st = makeState()
  const routine = { id: 'dated', ex: [] }
  // Add/swap starts with a fresh config and inherits the current block's build exclusion.
  const built = buildPlannedEntry(st, cfg, routine, { noProg: true })
  const entry = { id: cfg.id, ...built, noProg: true }
  expect(builtOutOfProgression(entry, routine)).toBe(true)
  const rebuilt = buildPlannedEntry(st, plannedConfigOf(entry), routine, { noProg: builtOutOfProgression(entry, routine) })
  expect(rebuilt.plan.kind).toBe('off')
  expect(builtOutOfProgression({ ...entry, target: rebuilt.target }, routine)).toBe(true)
})

for (const combined of [false, true]) {
  it(`preserves source history lineage for ${combined ? 'combined repeated exercises' : 'a single routine'} through copied and source sessions`, () => {
    const planned = { id: '0025', sets: 2, reps: 5, weight: 40 }
    const history = (rid, weight, d) => ({ id: rid, d, routineIds: [rid], entries: [{ id: planned.id, rid, planned, target: { ...planned, weight }, sets: [1, 2].map(() => ({ w: weight, r: 5, done: true })) }] })
    const st = {
      unit: 'kg', exWeights: {}, dayPlan: {}, week: { 1: combined ? ['heavy', 'light'] : ['heavy'] },
      routines: ['heavy', 'light'].map(id => ({ id, name: id, prog: 'linear', ex: [{ ...planned }] })),
      workouts: [history('heavy', 100, '2026-10-16'), history('light', 50, '2026-10-17')],
    }
    expect(buildCombinedEntries(st, ['heavy']).entries[0].target.weight).toBe(102.5)
    const p = localRecords(st, options).find(r => r.kind === 'plan')
    applyRecord(st, 'plan', p.key, { ...p.value, name: 'Renamed' }, 100, options)
    const id = st.dayPlan[p.value.date]
    const built = buildCombinedEntries(st, [id])
    expect(built.entries.map(e => e.target.weight)).toEqual(combined ? [102.5, 52.5] : [102.5])
    expect(built.entries.map(e => e.rid)).toEqual(combined ? [id, id] : [id])
    st.workouts.push(buildCompletedWorkout({ id: 'dated', d: p.value.date, routineIds: [id], entries: built.entries.map(e => ({ ...e, sets: e.sets.map(s => ({ ...s, done: true })) })) }))
    // An unrelated later light session must not overwrite the heavy source's line of progress.
    st.workouts.push(history('light', 60, '2026-10-20'))
    expect(buildCombinedEntries(st, ['heavy']).entries[0].target.weight).toBe(105)
    expect(buildCombinedEntries(st, ['light']).entries[0].target.weight).toBe(62.5)
    applyRecord(st, 'plan', p.key, { ...p.value, name: 'Renamed again' }, 200, options)
    expect(buildCombinedEntries(st, [id]).entries.map(e => e.target.weight)).toEqual(combined ? [105, 62.5] : [105])
    // Another date copied from the reusable original continues the same lineage too.
    const next = localRecords(st, options).find(r => r.kind === 'plan' && r.value.date === '2026-10-26')
    // The shorter test window excludes that date; explicitly export a longer one.
    const later = next || localRecords(st, { ...options, futureDays: 14 }).find(r => r.kind === 'plan' && r.value.date === '2026-10-26')
    applyRecord(st, 'plan', later.key, { ...later.value, name: 'Next copied day' }, 300, { ...options, futureDays: 14 })
    expect(buildCombinedEntries(st, [st.dayPlan[later.value.date]]).entries.map(e => e.target.weight)).toEqual(combined ? [105, 62.5] : [105])
  })
}
