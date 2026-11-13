import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useI18n } from '../lib/i18n'
import { useToast } from './Toast'

/** Tells the user when their data can't be saved or loaded. Renders nothing. */
export function PersistenceNotifier() {
  const { persistence } = useStore()
  const { t } = useI18n()
  const toast = useToast()
  const lastKindRef = useRef(persistence.kind)

  useEffect(() => {
    // Only notify on transitions, not on every retry.
    if (persistence.kind === lastKindRef.current) return
    lastKindRef.current = persistence.kind

    if (persistence.kind === 'saveError') {
      toast.error(t('common.saveFailed') ?? "Your changes couldn't be saved.", { durationMs: 8000 })
    } else if (persistence.kind === 'loadError') {
      toast.error(t('common.loadFailed') ?? "Your saved data couldn't be read.", { durationMs: 15000 })
    }
  }, [persistence, t, toast])

  return null
}
