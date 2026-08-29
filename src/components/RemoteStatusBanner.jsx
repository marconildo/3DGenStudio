import { useRemote } from '../context/RemoteContext.shared'
import './RemoteStatusBanner.css'

// A strip across the top when the shared server needs attention.
//
// It stays silent in the two normal states — no server configured (a plain
// desktop install) and connected-and-writable — so it only ever appears when
// something the user can act on is true.
export default function RemoteStatusBanner() {
  const remote = useRemote()

  if (remote.loading || !remote.configured) return null

  const server = remote.url || 'the shared server'

  // `reachable` comes from the backend's own probe of the server and is the
  // reliable signal. `unreachable` is only set when a data request actually
  // failed, which no longer happens while the offline fallback is on — those
  // requests succeed against local data instead.
  const isDown = remote.reachable === false || remote.unreachable

  // Ordered by severity: an unreachable server hides everything else, and being
  // signed out matters more than being read-only.
  let variant = null
  let icon = ''
  let message = ''

  if (remote.connected && isDown && remote.offlineFallback) {
    // The loudest state in the app, deliberately. The projects on screen are
    // this computer's, NOT the server's — a different set of work entirely —
    // and anything made now stays here. Saying "offline" without saying that
    // would invite someone to mistake it for their usual workspace.
    variant = 'error'
    icon = 'cloud_off'
    message = `Working offline on this computer — can't reach ${server}. `
      + 'These are this computer\'s own projects, not the server\'s, and anything you '
      + 'create now stays here. Reconnects by itself when the server is back.'
  } else if (remote.connected && isDown) {
    variant = 'error'
    icon = 'cloud_off'
    message = `Can't reach ${server}. Local tools still work, but projects and assets are paused until it's back.`
  } else if (!remote.connected) {
    variant = 'warning'
    icon = 'lock'
    message = `Not signed in to ${server}. Open Settings → Server to sign in; your projects and assets live there.`
  } else if (remote.readOnly) {
    variant = 'info'
    icon = 'visibility'
    message = `Signed in to ${server} as ${remote.login} with view-only access. You can browse everything but not change it.`
  }

  if (!variant) return null

  return (
    <div className={`remote-banner remote-banner--${variant}`} role="status">
      <span className="material-symbols-outlined remote-banner__icon">{icon}</span>
      <span className="remote-banner__text">{message}</span>
    </div>
  )
}
