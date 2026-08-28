import { createContext, useContext } from 'react'

export const RemoteContext = createContext(null)

// Safe outside the provider: a component can ask about the shared server
// without caring whether this build wires one up.
export function useRemote() {
  return useContext(RemoteContext) || {
    configured: false,
    connected: false,
    url: '',
    login: '',
    user: null,
    role: null,
    readOnly: false,
    loading: false,
    unreachable: false
  }
}
