import { createContext, useContext } from 'react'

export const ServerSessionContext = createContext(null)

// Safe outside the provider, and its defaults are the desktop case: not a shared
// server, nothing to sign in to. A component can therefore ask about the browser
// session without caring which build it is running in.
export function useServerSession() {
  return useContext(ServerSessionContext) || {
    checking: false,
    serverMode: false,
    user: null,
    role: null,
    readOnly: false,
    signIn: async () => {},
    signOut: async () => {}
  }
}
