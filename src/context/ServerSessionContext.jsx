import { useCallback, useEffect, useMemo, useState } from 'react'
import { API_BASE } from '../config'
import { ServerSessionContext } from './ServerSessionContext.shared'

// Who you are when the app is served BY a shared server.
//
// Not to be confused with RemoteContext, which is the mirror image: that one is
// a desktop install *connecting out* to a server, and there the JWT never
// touches the browser — the local backend holds it. Here the browser is talking
// straight to the server, so it authenticates itself. The token still never
// reaches JavaScript: /api/auth/login sets an HttpOnly cookie, which is also
// what lets <img> and three.js load asset bytes, since neither can set headers.
//
// On a desktop install this whole provider is inert: one call to /api/health
// reports mode 'local' and it renders its children unconditionally, exactly as
// before.
export function ServerSessionProvider({ children, renderLogin }) {
  const [state, setState] = useState({ checking: true, serverMode: false, user: null })

  const loadUser = useCallback(async () => {
    const res = await fetch(`${API_BASE}/auth/me`)
    if (!res.ok) return null
    return (await res.json().catch(() => null))?.user || null
  }, [])

  useEffect(() => {
    let cancelled = false

    const detect = async () => {
      let health = null
      try {
        // Public in both modes, and the only route that answers before you could
        // possibly hold a token — which is exactly what makes it the mode probe.
        const res = await fetch(`${API_BASE}/health`)
        if (res.ok) health = await res.json()
      } catch {
        // The backend is unreachable. Nothing here can help with that, and other
        // surfaces already report it; fall through as a normal local install so
        // the app renders and shows its own errors.
      }

      if (health?.mode !== 'server') {
        if (!cancelled) setState({ checking: false, serverMode: false, user: null })
        return
      }

      const user = await loadUser().catch(() => null)
      if (!cancelled) setState({ checking: false, serverMode: true, user })
    }

    detect()
    return () => { cancelled = true }
  }, [loadUser])

  const signIn = useCallback(async ({ login, password }) => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password })
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error || `Sign-in failed (${res.status})`)
    // The response carries a token too, for API clients. The browser ignores it
    // and relies on the cookie: anything stored in JS would also be readable by
    // anything else running on the page.
    setState(prev => ({ ...prev, user: data?.user || null }))
    return data?.user || null
  }, [])

  const signOut = useCallback(async () => {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST' }).catch(() => {})
    setState(prev => ({ ...prev, user: null }))
  }, [])

  const value = useMemo(() => ({
    checking: state.checking,
    serverMode: state.serverMode,
    user: state.user,
    role: state.user?.role || null,
    readOnly: state.serverMode && state.user?.role === 'viewer',
    signIn,
    signOut
  }), [state, signIn, signOut])

  // Nothing renders until the mode is known. A flash of the login form on a
  // desktop install would be worse than the few milliseconds this costs, and on
  // a server it stops every data provider below from firing a round of 401s.
  if (state.checking) return null

  const gated = state.serverMode && !state.user

  return (
    <ServerSessionContext.Provider value={value}>
      {gated ? renderLogin({ signIn }) : children}
    </ServerSessionContext.Provider>
  )
}
