import { useState } from 'react'
import './ServerLoginPage.css'

// Sign-in for the browser UI a shared server serves itself.
//
// This is the ONLY screen rendered until it succeeds: it stands in place of the
// whole app, so no data provider below it fires a request that would just 401.
// The desktop app never reaches this — it signs in on your behalf from
// Settings -> Server, and the token stays in its own backend.
export default function ServerLoginPage({ signIn }) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const canSubmit = Boolean(login && password) && !busy

  const submit = async (event) => {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      await signIn({ login, password })
      // No navigation: the provider swaps this screen for the app as soon as it
      // has a user.
    } catch (err) {
      setError(err.message || 'Sign-in failed')
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="server-login">
      <form className="server-login__card" onSubmit={submit}>
        <div className="server-login__brand">
          <span className="material-symbols-outlined server-login__icon">dns</span>
          <div>
            <h1 className="server-login__title font-headline">3D Gen Studio</h1>
            <p className="server-login__subtitle font-label">Shared server</p>
          </div>
        </div>

        <p className="server-login__helper">
          Sign in to browse the team’s projects and assets. Generation, mesh tools and
          ComfyUI run in the desktop app on your own machine — they are not available here.
        </p>

        {/* aria-live so a screen reader announces a failed attempt, which is
            otherwise a silent change on a form that looks unchanged. */}
        <p className="server-login__error" role="alert" aria-live="polite">
          {error}
        </p>

        <label className="server-login__label" htmlFor="server-login-user">Login</label>
        <input
          id="server-login-user"
          className="server-login__input"
          autoComplete="username"
          autoFocus
          value={login}
          disabled={busy}
          onChange={e => setLogin(e.target.value)}
        />

        <label className="server-login__label" htmlFor="server-login-password">Password</label>
        <input
          id="server-login-password"
          className="server-login__input"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={e => setPassword(e.target.value)}
        />

        <button className="server-login__submit" type="submit" disabled={!canSubmit}>
          {busy ? 'SIGNING IN…' : 'SIGN IN'}
        </button>
      </form>
    </div>
  )
}
