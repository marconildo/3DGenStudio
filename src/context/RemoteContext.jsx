import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../config'
import { RemoteContext } from './RemoteContext.shared'

// Connection to a shared 3D Gen Studio server.
//
// The token itself never reaches the browser: credentials are posted to this
// install's own backend, which holds the JWT and injects it when forwarding.
// So everything here is status, not secrets.
const EMPTY_STATUS = {
  configured: false,
  connected: false,
  url: '',
  login: '',
  user: null,
  role: null,
  readOnly: false
}

// Slow on purpose. This is a background health signal, not something the user is
// waiting on — the banner only has to notice a server going away within a few
// seconds, and a tight poll on every open tab would be pure noise.
const POLL_INTERVAL_MS = 15000

export function RemoteProvider({ children }) {
  const [status, setStatus] = useState(EMPTY_STATUS)
  const [loading, setLoading] = useState(true)
  // Set when a *data* request fails because the server is unreachable, so the
  // banner can distinguish "not signed in" from "signed in but the server is
  // down" — two very different things for the user to act on.
  const [unreachable, setUnreachable] = useState(false)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/remote`)
      if (!res.ok) {
        // In server mode the route is not mounted at all; treat that as "no
        // remote configured" rather than an error.
        if (mountedRef.current) setStatus(EMPTY_STATUS)
        return EMPTY_STATUS
      }
      const data = await res.json()
      if (mountedRef.current) {
        setStatus({ ...EMPTY_STATUS, ...data })
        if (data.connected) setUnreachable(false)
      }
      return data
    } catch {
      // The local backend itself is unreachable; the app has bigger problems
      // than the remote, and other surfaces already report that.
      return null
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    // Deferred by a tick rather than called inline: the first poll would
    // otherwise setState synchronously inside the effect body and cascade a
    // second render before the first has painted.
    const initialPoll = setTimeout(refresh, 0)
    const timer = setInterval(refresh, POLL_INTERVAL_MS)
    return () => {
      mountedRef.current = false
      clearTimeout(initialPoll)
      clearInterval(timer)
    }
  }, [refresh])

  const signIn = useCallback(async ({ url, login, password }) => {
    const res = await fetch(`${API_BASE}/remote/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, login, password })
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error || `Sign-in failed (${res.status})`)
    setStatus({ ...EMPTY_STATUS, ...data })
    setUnreachable(false)
    return data
  }, [])

  const signOut = useCallback(async () => {
    const res = await fetch(`${API_BASE}/remote/logout`, { method: 'POST' })
    const data = await res.json().catch(() => null)
    if (data) setStatus({ ...EMPTY_STATUS, ...data })
    return data
  }, [])

  // Forget the server entirely and fall back to this machine's own database.
  const disconnect = useCallback(async () => {
    const res = await fetch(`${API_BASE}/remote`, { method: 'DELETE' })
    const data = await res.json().catch(() => null)
    setStatus(data ? { ...EMPTY_STATUS, ...data } : EMPTY_STATUS)
    setUnreachable(false)
    return data
  }, [])

  // Called by the error path of data requests. 503 means the gateway could not
  // reach the server; 401 means the stored session was rejected.
  const reportRequestFailure = useCallback((httpStatus) => {
    if (httpStatus === 503) setUnreachable(true)
    if (httpStatus === 401) refresh()
  }, [refresh])

  const value = useMemo(() => ({
    ...status,
    loading,
    unreachable,
    signIn,
    signOut,
    disconnect,
    refresh,
    reportRequestFailure
  }), [status, loading, unreachable, signIn, signOut, disconnect, refresh, reportRequestFailure])

  return <RemoteContext.Provider value={value}>{children}</RemoteContext.Provider>
}
