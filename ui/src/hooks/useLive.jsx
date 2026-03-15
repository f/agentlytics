import { useState, useEffect, useCallback } from 'react'

const KEY = 'agentlytics-live'

export function useLive() {
  const [live, setLive] = useState(() => localStorage.getItem(KEY) === 'true')

  useEffect(() => {
    localStorage.setItem(KEY, live)
  }, [live])

  const toggle = useCallback(() => setLive(l => !l), [])

  return { live, toggle }
}
