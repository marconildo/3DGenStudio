import { useCallback, useEffect, useState } from 'react'
import { API_BASE } from '../config'
import { useRemote } from '../context/RemoteContext.shared'
import { useServerSession } from '../context/ServerSessionContext.shared'
import './ServerSettingsTab.css'

const ROLES = [
  { value: 'admin', label: 'Administrator' },
  { value: 'user', label: 'User' },
  { value: 'viewer', label: 'Viewer (read-only)' }
]

// Settings → Server.
//
// Two different situations wear the same tab, and only one of them is about a
// *connection*: a desktop install reaching out to a shared server, or a browser
// already being served by one. Split into two components rather than branching
// inside one, so neither ends up calling hooks conditionally.
export default function ServerSettingsTab() {
  const session = useServerSession()

  // Browsing the shared server directly: there is nothing to configure, because
  // this IS the server — and /api/remote does not even exist here.
  return session.serverMode
    ? <BrowserSessionSection session={session} />
    : <RemoteConnectionSection />
}

// Connects this install to a shared 3D Gen Studio server. What stays local
// matters as much as what moves: ComfyUI, the Python sidecars and every
// third-party API key remain on this machine — only projects, assets and
// workflow definitions live on the server.
function RemoteConnectionSection() {
  const remote = useRemote()

  // null means "not edited yet", so the fields fall back to the stored
  // connection without an effect syncing two sources of truth.
  const [edited, setEdited] = useState({ url: null, login: null })
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const url = edited.url ?? remote.url ?? ''
  const login = edited.login ?? remote.login ?? ''
  const isAdmin = remote.connected && remote.role === 'admin'

  const run = async (action) => {
    setBusy(true); setError(''); setNotice('')
    try {
      await action()
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const handleSignIn = () => run(async () => {
    const result = await remote.signIn({ url, login, password })
    setPassword('')
    setNotice(`Signed in to ${result.url} as ${result.login}.`)
  })

  const handleSignOut = () => run(async () => {
    await remote.signOut()
    setNotice('Signed out. Projects and assets stay on the server until you sign in again.')
  })

  const handleDisconnect = () => run(async () => {
    await remote.disconnect()
    setEdited({ url: null, login: null })
    setNotice('Disconnected. This installation is using its own local database again.')
  })

  const statusTone = !remote.configured
    ? 'off'
    : !remote.connected ? 'warn'
      : remote.unreachable ? 'error' : 'on'

  return (
    <>
      <section className="settings-section">
        <h3 className="settings-section-title font-label">Shared Server</h3>

        <div className="settings-api-card">
          <div className="settings-api-header">
            <div className="settings-api-icon">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>dns</span>
            </div>
            <span className="settings-api-name">Connection</span>
            <span className={`server-dot server-dot--${statusTone}`} />
          </div>

          <p className="settings-helper-text">
            Work on the same projects and assets as your team. Generation always runs on
            <strong> this </strong>machine — ComfyUI, the mesh tools and your API keys stay
            local and are never sent to the server.
          </p>

          <p className="server-status-line">
            {!remote.configured && 'Not connected — using this machine’s local database.'}
            {remote.configured && !remote.connected && `Configured but signed out — ${remote.url}`}
            {remote.configured && remote.connected && !remote.unreachable &&
              `Connected to ${remote.url} as ${remote.login}${remote.role ? ` (${remote.role})` : ''}`}
            {remote.configured && remote.connected && remote.unreachable &&
              `Signed in to ${remote.url}, but it is not responding.`}
          </p>

          {error && <p className="server-message server-message--error">{error}</p>}
          {notice && <p className="server-message server-message--ok">{notice}</p>}

          <div className="settings-input-group">
            <label className="settings-label">Server address</label>
            <input
              className="settings-input"
              placeholder="http://studio.example.com:3001"
              value={url}
              disabled={busy}
              onChange={e => setEdited(prev => ({ ...prev, url: e.target.value }))}
            />
          </div>

          <div className="settings-input-group">
            <label className="settings-label">Login</label>
            <input
              className="settings-input"
              autoComplete="username"
              value={login}
              disabled={busy}
              onChange={e => setEdited(prev => ({ ...prev, login: e.target.value }))}
            />
          </div>

          <div className="settings-input-group">
            <label className="settings-label">Password</label>
            <input
              className="settings-input"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !busy && url && login && password) handleSignIn() }}
            />
          </div>

          <div className="server-actions">
            <button
              className="settings-btn-primary"
              disabled={busy || !url || !login || !password}
              onClick={handleSignIn}
            >
              {remote.connected ? 'RE-SIGN IN' : 'SIGN IN'}
            </button>
            {remote.connected && (
              <button className="server-btn" disabled={busy} onClick={handleSignOut}>SIGN OUT</button>
            )}
            {remote.configured && (
              <button className="server-btn" disabled={busy} onClick={handleDisconnect}>DISCONNECT</button>
            )}
          </div>
        </div>
      </section>

      {isAdmin && <UserAdminSection />}
    </>
  )
}

// Settings -> Server, as seen from a browser the shared server is serving.
function BrowserSessionSection({ session }) {
  const [busy, setBusy] = useState(false)
  const role = session.role || 'user'

  const handleSignOut = async () => {
    setBusy(true)
    // No finally-unsetting busy: signing out swaps this whole tree for the login
    // screen, so re-enabling the button would only ever flicker on failure.
    try {
      await session.signOut()
    } catch {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="settings-section">
        <h3 className="settings-section-title font-label">Shared Server</h3>

        <div className="settings-api-card">
          <div className="settings-api-header">
            <div className="settings-api-icon">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>dns</span>
            </div>
            <span className="settings-api-name">This Session</span>
            <span className="server-dot server-dot--on" />
          </div>

          <p className="settings-helper-text">
            You are browsing the shared server in a web browser. Generation, mesh tools
            and ComfyUI need the desktop app — install it and connect it to this server
            to create new assets.
          </p>

          <p className="server-status-line">
            {`Signed in as ${session.user?.displayName || session.user?.login || 'unknown'} (${role})`}
            {session.readOnly && ' — view only'}
          </p>

          <div className="server-actions">
            <button className="server-btn" disabled={busy} onClick={handleSignOut}>SIGN OUT</button>
          </div>
        </div>
      </section>

      {role === 'admin' && <UserAdminSection />}
    </>
  )
}

// Administrators only. Reaches /api/users through this install's own backend,
// which the gateway forwards to the server with the stored token — or, in a
// browser served by the server itself, straight there with the session cookie.
function UserAdminSection() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({ login: '', password: '', displayName: '', role: 'user' })

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch(`${API_BASE}/users`)
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error || `Could not load users (${res.status})`)
      }
      setUsers(await res.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Deferred a tick so the first load does not setState inside the effect body.
    const initial = setTimeout(load, 0)
    return () => clearTimeout(initial)
  }, [load])

  const act = async (label, request) => {
    setBusy(true); setError('')
    try {
      const res = await request()
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error || `${label} failed (${res.status})`)
      }
      await load()
      return true
    } catch (err) {
      setError(err.message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const patch = (user, body) => act('Update user', () => fetch(`${API_BASE}/users/${user.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }))

  const handleCreate = async () => {
    const ok = await act('Create user', () => fetch(`${API_BASE}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft)
    }))
    if (ok) setDraft({ login: '', password: '', displayName: '', role: 'user' })
  }

  return (
    <section className="settings-section">
      <h3 className="settings-section-title font-label">Users</h3>

      <div className="settings-api-card">
        <p className="settings-helper-text">
          Accounts on the shared server. It refuses to demote, disable or delete the last
          administrator, so you cannot lock everyone out from here.
        </p>

        {error && <p className="server-message server-message--error">{error}</p>}

        {loading ? <p className="settings-helper-text">Loading users…</p> : (
          <div className="user-list">
            {users.map(user => (
              <div className={`user-row ${user.disabled ? 'user-row--disabled' : ''}`} key={user.id}>
                <div className="user-row__identity">
                  <span className="user-row__login">{user.login}</span>
                  {user.displayName && user.displayName !== user.login && (
                    <span className="user-row__name">{user.displayName}</span>
                  )}
                  {user.disabled && <span className="user-row__badge">DISABLED</span>}
                </div>
                <select
                  className="settings-input user-row__role"
                  value={user.role}
                  disabled={busy}
                  onChange={e => patch(user, { role: e.target.value })}
                >
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <button className="server-btn" disabled={busy} onClick={() => patch(user, { disabled: !user.disabled })}>
                  {user.disabled ? 'ENABLE' : 'DISABLE'}
                </button>
                <button
                  className="server-btn"
                  disabled={busy}
                  onClick={() => act('Delete user', () => fetch(`${API_BASE}/users/${user.id}`, { method: 'DELETE' }))}
                >
                  DELETE
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-api-card">
        <div className="settings-api-header">
          <div className="settings-api-icon">
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>person_add</span>
          </div>
          <span className="settings-api-name">Add a user</span>
        </div>

        <div className="settings-input-group">
          <label className="settings-label">Login</label>
          <input className="settings-input" value={draft.login} disabled={busy}
            onChange={e => setDraft({ ...draft, login: e.target.value })} />
        </div>
        <div className="settings-input-group">
          <label className="settings-label">Password</label>
          <input className="settings-input" type="password" autoComplete="new-password"
            value={draft.password} disabled={busy}
            onChange={e => setDraft({ ...draft, password: e.target.value })} />
        </div>
        <div className="settings-input-group">
          <label className="settings-label">Display name <span style={{ opacity: 0.6, fontWeight: 400 }}>(optional)</span></label>
          <input className="settings-input" value={draft.displayName} disabled={busy}
            onChange={e => setDraft({ ...draft, displayName: e.target.value })} />
        </div>
        <div className="settings-input-group">
          <label className="settings-label">Role</label>
          <select className="settings-input" value={draft.role} disabled={busy}
            onChange={e => setDraft({ ...draft, role: e.target.value })}>
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        <div className="server-actions">
          <button className="settings-btn-primary"
            disabled={busy || !draft.login || draft.password.length < 8}
            onClick={handleCreate}>
            ADD USER
          </button>
          {draft.password.length > 0 && draft.password.length < 8 && (
            <span className="settings-helper-text">Password must be at least 8 characters.</span>
          )}
        </div>
      </div>
    </section>
  )
}
