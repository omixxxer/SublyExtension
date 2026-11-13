import { describe, it, expect } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  createId,
  migrateState,
  normalizeState,
  readSchemaVersion,
  serializeState,
} from './storage'

const legacyState = {
  // Saved before versioning existed: no schemaVersion, old single `category` field.
  subscriptions: [
    { id: '1700000000000-abc', name: 'Netflix', category: 'Video', price: 12.99, currency: 'EUR', period: 'monthly', startDate: '2024-01-15' },
  ],
  settings: { language: 'en', currencyDisplayMode: 'convertToBase', baseCurrency: 'eur', calendarReminderDaysBefore: 999 },
}

describe('readSchemaVersion()', () => {
  it('treats missing or invalid versions as 0', () => {
    expect(readSchemaVersion(undefined)).toBe(0)
    expect(readSchemaVersion({})).toBe(0)
    expect(readSchemaVersion({ schemaVersion: '1' })).toBe(0)
    expect(readSchemaVersion({ schemaVersion: -1 })).toBe(0)
    expect(readSchemaVersion({ schemaVersion: 1.5 })).toBe(0)
  })

  it('reads valid versions', () => {
    expect(readSchemaVersion({ schemaVersion: 1 })).toBe(1)
  })
})

describe('migrateState()', () => {
  it('returns null for non-object input', () => {
    expect(migrateState(null)).toBeNull()
    expect(migrateState('x')).toBeNull()
    expect(migrateState([1, 2])).toBeNull()
  })

  it('upgrades unversioned data to the current version', () => {
    const migrated = migrateState(legacyState)
    expect(migrated?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated?.subscriptions).toEqual(legacyState.subscriptions)
  })

  it('does not mutate its input', () => {
    const input = structuredClone(legacyState)
    migrateState(input)
    expect(input).toEqual(legacyState)
  })

  it('keeps data from a newer schema as-is (best effort)', () => {
    const future = { ...legacyState, schemaVersion: CURRENT_SCHEMA_VERSION + 1 }
    expect(migrateState(future)?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION + 1)
  })
})

describe('normalizeState()', () => {
  it('returns defaults when nothing is stored', () => {
    const state = normalizeState(null)
    expect(state.subscriptions).toEqual([])
    expect(state.settings.language).toBe(DEFAULT_SETTINGS.language)
    expect(state.settings.baseCurrency).toBe(DEFAULT_SETTINGS.baseCurrency)
  })

  it('upgrades legacy data without losing subscriptions', () => {
    const state = normalizeState(legacyState)
    expect(state.subscriptions).toHaveLength(1)
    expect(state.subscriptions[0].name).toBe('Netflix')
    expect(state.subscriptions[0].categories).toEqual(['Video'])
    expect(state.subscriptions[0].category).toBe('Video')
    expect(state.settings.language).toBe('en')
    expect(state.settings.currencyDisplayMode).toBe('convertToBase')
    expect(state.settings.baseCurrency).toBe('EUR')
    expect(state.settings.calendarReminderDaysBefore).toBe(365)
  })

  it('does not leak schemaVersion into the in-memory state', () => {
    const state = normalizeState({ ...legacyState, schemaVersion: CURRENT_SCHEMA_VERSION })
    expect('schemaVersion' in state).toBe(false)
  })

  it('is stable: normalising serialized state gives the same state back', () => {
    const once = normalizeState(legacyState)
    const roundTripped = normalizeState(JSON.parse(JSON.stringify(serializeState(once))))
    expect(roundTripped).toEqual(once)
  })
})

describe('serializeState()', () => {
  it('stamps the current schema version', () => {
    const stored = serializeState(normalizeState(null))
    expect(stored.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })
})

describe('createId()', () => {
  it('returns unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createId()))
    expect(ids.size).toBe(1000)
  })
})
