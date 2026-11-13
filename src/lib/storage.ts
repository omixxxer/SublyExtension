import type { AppSettings, AppState, Subscription } from './types'
import { logger } from './logger'

const KEY = 'subly:state'

/** chrome.storage / localStorage key holding the persisted state. */
export const STATE_STORAGE_KEY = KEY

/**
 * Version of the persisted data shape. Bump it whenever a change needs existing
 * user data to be transformed, and add the matching step to MIGRATIONS.
 */
export const CURRENT_SCHEMA_VERSION = 1

/** What is actually written to storage: the app state plus its schema version. */
export type StoredState = AppState & { schemaVersion: number }

type RawState = Record<string, unknown>

/**
 * MIGRATIONS[n] upgrades data stored at schemaVersion n to n + 1.
 * Never edit or remove a released step: some users may still have data at that version.
 * Field-level cleanup that should always apply (defaults, clamping, legacy `category`)
 * stays in normalizeState, which runs after the migrations.
 */
const MIGRATIONS: Record<number, (raw: RawState) => RawState> = {
  // v0 -> v1: baseline. v0 is everything saved before data was versioned.
  0: (raw) => raw,
}

export function readSchemaVersion(input: unknown): number {
  const v = (input as { schemaVersion?: unknown } | null | undefined)?.schemaVersion
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
}

/** Runs every pending migration on raw persisted data. Returns null for non-objects. */
export function migrateState(input: unknown): RawState | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null

  let data: RawState = { ...(input as RawState) }
  let version = readSchemaVersion(data)

  if (version > CURRENT_SCHEMA_VERSION) {
    // Data written by a newer build (e.g. a backup restored from a newer version).
    // Best effort: normalizeState keeps the fields this build understands.
    logger.warn('Stored data has a newer schema than this build', {
      context: 'migrateState',
      details: { stored: version, current: CURRENT_SCHEMA_VERSION },
    })
    return data
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version]
    if (!step) throw new Error(`Missing data migration from schema v${version}`)
    data = step(data)
    version += 1
  }
  data.schemaVersion = version
  return data
}

/** Adds the schema version to the state so it can be written to storage. */
export function serializeState(state: AppState): StoredState {
  return { ...state, schemaVersion: CURRENT_SCHEMA_VERSION }
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'es',
  currencyDisplayMode: 'original',
  baseCurrency: 'USD',
  calendarAutoSyncAll: true,
  calendarFloatingButtonEnabled: true,
  calendarReminderDaysBefore: 1,
  calendarReminderMethod: 'popup',
  onboardingCompleted: false,
  driveBackupFileId: undefined,
  driveLastBackupAt: undefined,
}

export function normalizeState(raw: unknown): AppState {
  const input = migrateState(raw) as Partial<AppState> | null
  const rawSubscriptions = Array.isArray(input?.subscriptions) ? input!.subscriptions : []
  const subscriptions = rawSubscriptions.map((sub) => {
    const list = [
      ...(Array.isArray(sub?.categories) ? sub.categories : []),
      typeof sub?.category === 'string' ? sub.category : '',
    ]
      .map(v => String(v || '').trim())
      .filter(Boolean)

    const uniqueCategories = Array.from(new Set(list))

    return {
      ...sub,
      categories: uniqueCategories.length ? uniqueCategories : undefined,
      category: uniqueCategories[0] ?? undefined,
    }
  })
  const rawSettings = (input as AppState | undefined)?.settings
  const language = rawSettings?.language === 'en' ? 'en' : 'es'
  const display = rawSettings?.currencyDisplayMode === 'convertToBase' ? 'convertToBase' : 'original'
  const baseCurrency = String(rawSettings?.baseCurrency ?? DEFAULT_SETTINGS.baseCurrency).trim().toUpperCase() || DEFAULT_SETTINGS.baseCurrency
  const calendarAutoSyncAll = Boolean(rawSettings?.calendarAutoSyncAll ?? DEFAULT_SETTINGS.calendarAutoSyncAll)
  const calendarFloatingButtonEnabled = rawSettings?.calendarFloatingButtonEnabled === false ? false : true

  const toIntInRange = (v: unknown, fallback: number, min: number, max: number) => {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) return fallback
    const i = Math.trunc(n)
    if (i < min) return min
    if (i > max) return max
    return i
  }

  const calendarReminderDaysBefore = toIntInRange(
    rawSettings?.calendarReminderDaysBefore,
    DEFAULT_SETTINGS.calendarReminderDaysBefore ?? 1,
    0,
    365,
  )

  const calendarReminderMethod = rawSettings?.calendarReminderMethod === 'email' ? 'email' : 'popup'

  const onboardingCompleted = Boolean(rawSettings?.onboardingCompleted ?? DEFAULT_SETTINGS.onboardingCompleted)
  const calendarSubscriptionsCalendarId = String(rawSettings?.calendarSubscriptionsCalendarId ?? '').trim() || undefined
  const driveBackupFileId = String(rawSettings?.driveBackupFileId ?? '').trim() || undefined
  const driveLastBackupAt = String(rawSettings?.driveLastBackupAt ?? '').trim() || undefined
  return {
    subscriptions,
    settings: {
      language,
      currencyDisplayMode: display,
      baseCurrency,
      calendarAutoSyncAll,
      calendarFloatingButtonEnabled,
      calendarReminderDaysBefore,
      calendarReminderMethod,
      onboardingCompleted,
      calendarSubscriptionsCalendarId,
      driveBackupFileId,
      driveLastBackupAt,
    },
  }
}

function isExtension() {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local
}

/**
 * Reads the persisted data exactly as stored (null when nothing is saved yet).
 * Throws when storage can't be read or holds unparseable data, so callers never
 * mistake a failed read for an empty account and overwrite real data.
 */
export async function readStoredState(): Promise<unknown> {
  if (isExtension()) {
    const res = await chrome.storage.local.get([KEY])
    return res?.[KEY] ?? null
  }

  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
  if (!raw) return null
  return JSON.parse(raw)
}

export async function loadState(): Promise<AppState> {
  return normalizeState(await readStoredState())
}

/** Writes already-serialized state. */
export async function writeStoredState(stored: StoredState): Promise<void> {
  if (isExtension()) {
    await chrome.storage.local.set({ [KEY]: stored })
    return
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(KEY, JSON.stringify(stored))
  }
}

export async function saveState(state: AppState): Promise<void> {
  await writeStoredState(serializeState(state))
}

/**
 * Subscribes to changes of the persisted state made by other extension pages
 * (another side panel window, etc.). Returns an unsubscribe function.
 */
export function onStoredStateChanged(listener: (raw: unknown) => void): () => void {
  if (isExtension() && chrome.storage?.onChanged) {
    const handler = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local' || !changes[KEY]) return
      listener(changes[KEY].newValue ?? null)
    }
    chrome.storage.onChanged.addListener(handler)
    return () => chrome.storage.onChanged.removeListener(handler)
  }

  if (typeof window !== 'undefined') {
    // Web build: the storage event fires in other tabs of the same origin.
    const handler = (e: StorageEvent) => {
      if (e.key !== KEY) return
      try {
        listener(e.newValue ? JSON.parse(e.newValue) : null)
      } catch {
        // Ignore unparseable writes from elsewhere.
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }

  return () => {}
}

export function createId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function nextRenewalDate(startDate: string, period: Subscription['period'], from = new Date()): Date {
  const [y, m, d] = startDate.split('-').map(Number)
  
  // Validate month and day are in reasonable ranges
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return from
  if (m < 1 || m > 12 || d < 1 || d > 31) return from
  
  const base = new Date(y, (m ?? 1) - 1, d ?? 1)
  if (Number.isNaN(base.getTime())) return from

  /**
   * Safely add months to a date, handling end-of-month dates.
   * Remembers the original day to restore it when possible.
   * E.g., Jan 31 + 1 month = Feb 28/29, then + 1 month = Mar 31.
   * See: https://stackoverflow.com/questions/5645058
   */
  const addMonths = (date: Date, months: number, originalDay: number): Date => {
    let year = date.getFullYear()
    let month = date.getMonth() + months
    
    // Handle month overflow
    year += Math.floor(month / 12)
    month = month % 12
    
    // Try to create date with the original day
    let result = new Date(year, month, originalDay)
    
    // If day doesn't exist in target month, use last day of that month
    if (result.getMonth() !== month) {
      result = new Date(year, month + 1, 0)
    }
    
    return result
  }

  const step = period === 'monthly' ? 1 : period === 'quarterly' ? 3 : period === 'semiannual' ? 6 : 12
  const originalDay = base.getDate() // Remember the subscription's original day
  let cursor = new Date(base)
  
  while (cursor.getTime() <= from.getTime()) {
    cursor = addMonths(cursor, step, originalDay)
  }
  return cursor
}
