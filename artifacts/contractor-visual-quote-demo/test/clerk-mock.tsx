import type { ReactNode } from 'react';

// Only loaded by vite.browser.config.ts. Never used by the deployed application.
export function ClerkProvider({ children }: { children: ReactNode }) { return <>{children}</>; }
export function SignIn() { return null; }
export function SignUp() { return null; }
export function useAuth() { return { isLoaded: true, isSignedIn: true }; }
export function useClerk() { return { signOut: async () => {} }; }