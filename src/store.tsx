import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, AppState, Subscription } from './lib/types'
import {
  DEFAULT_SETTINGS,
  normalizeState,
  onStoredStateChanged,
  readStoredState,
  serializeState,
  writeStoredState,
} from './lib/storage'
import { logger } from './lib/logger'

/** Groups rapid edits (typing, toggles) into a single write. */
const SAVE_DEBOUNCE_MS = 250
/** Wait before retrying after a failed write. */
const SAVE_RETRY_MS = 5000

export type PersistenceStatus =
  | { kind: 'ok' }
  // Writes are failing; changes stay in memory and are retried.
  | { kind: 'saveError'; message: string }
  // Stored data couldn't be read; saving is disabled so it isn't overwritten.
  | { kind: 'loadError'; message: string }

type Store = {
  state: AppState
  setSubscriptions: (subs: Subscription[]) => void
  setSettings: (settings: AppSettings) => void
  ready: boolean
  persistence: PersistenceStatus
}

const StoreContext = createContext<Store | null>(null)

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>({ subscriptions: [], settings: DEFAULT_SETTINGS })
  const [ready, setReady] = useState(false)
  const [persistence, setPersistence] = useState<PersistenceStatus>({ kind: 'ok' })

  // Latest in-memory state, read by the (async) save loop.
  const stateRef = useRef(state)
  // JSON of what is known to be in storage right now; used to skip no-op writes and
  // to recognise our own writes when they come back through the change listener.
  const persistedJsonRef = useRef<string | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const savingRef = useRef(false)
  const loadFailedRef = useRef(false)

  const hasUnsavedChanges = () => saveTimerRef.current !== null || savingRef.current

  const flush = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (loadFailedRef.current || savingRef.current) return

    const stored = serializeState(stateRef.current)
    const json = JSON.stringify(stored)
    if (json === persistedJsonRef.current) return

    savingRef.current = true
    let failed = false
    try {
      await writeStoredState(stored)
      persistedJsonRef.current = json
      setPersistence(prev => (prev.kind === 'ok' ? prev : { kind: 'ok' }))
    } catch (e) {
      failed = true
      logger.error('Failed to save state', { context: 'store', error: e })
      setPersistence({ kind: 'saveError', message: errorMessage(e) })
    } finally {
      savingRef.current = false
    }

    // State may have changed while the write was in flight (or the write failed).
    if (JSON.stringify(serializeState(stateRef.current)) !== persistedJsonRef.current) {
      saveTimerRef.current = window.setTimeout(() => void flush(), failed ? SAVE_RETRY_MS : SAVE_DEBOUNCE_MS)
    }
  }, [])

  // Initial load.
  useEffect(() => {
    let mounted = true
    ;(async () => {
      let raw: unknown
      try {
        raw = await readStoredState()
      } catch (e) {
        if (!mounted) return
        logger.error('Failed to load state; saving disabled to protect stored data', { context: 'store', error: e })
        loadFailedRef.current = true
        setPersistence({ kind: 'loadError', message: errorMessage(e) })
        setReady(true)
        return
      }
      if (!mounted) return
      const loaded = normalizeState(raw)
      // Compare against the raw stored JSON: if normalising or migrating changed
      // anything, the save effect writes the upgraded data back once.
      persistedJsonRef.current = JSON.stringify(raw ?? null)
      stateRef.current = loaded
      setState(loaded)
      setReady(true)
    })()
    return () => {
      mounted = false
    }
  }, [])

  // Persist changes (debounced).
  useEffect(() => {
    stateRef.current = state
    if (!ready || loadFailedRef.current) return
    if (savingRef.current) return // the in-flight save reschedules itself if needed
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    // Nothing to write (e.g. the change came from another panel, or was undone):
    // don't leave a timer pending, or remote updates would be ignored meanwhile.
    if (JSON.stringify(serializeState(state)) === persistedJsonRef.current) return
    saveTimerRef.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
  }, [ready, state, flush])

  // Don't lose the last edit when the panel is closed or hidden.
  useEffect(() => {
    const onHide = () => {
      if (saveTimerRef.current !== null) void flush()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide()
    }
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [flush])

  // Keep several open panels (or tabs, in the web build) in sync.
  useEffect(() => {
    if (!ready || loadFailedRef.current) return
    return onStoredStateChanged((raw) => {
      const json = JSON.stringify(raw ?? null)
      if (json === persistedJsonRef.current) return // our own write, or nothing new
      // Local edits not yet written win (last writer wins): our pending save
      // will overwrite this change and the other panel will pick ours up.
      if (hasUnsavedChanges()) return

      const next = normalizeState(raw)
      persistedJsonRef.current = JSON.stringify(serializeState(next))
      stateRef.current = next
      setState(next)
    })
  }, [ready])

  const setSubscriptions = useCallback(
    (subs: Subscription[]) => setState(prev => ({ ...prev, subscriptions: subs })),
    [],
  )
  const setSettings = useCallback(
    (settings: AppSettings) => setState(prev => ({ ...prev, settings })),
    [],
  )

  const value = useMemo<Store>(
    () => ({ state, setSubscriptions, setSettings, ready, persistence }),
    [state, setSubscriptions, setSettings, ready, persistence],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
