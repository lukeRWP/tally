import { useState } from 'react';
import { Loader2, LogIn, AlertTriangle } from 'lucide-react';
import { useSearchParams } from 'react-router';

/**
 * What went wrong, in the user's words rather than the protocol's.
 *
 * @pw/auth-express sends a failed callback to `/login?error=auth_failed`;
 * anything unrecognised still gets a sentence — a failed sign-in once showed
 * "Signing in…" and then the button again with nothing said (#283), and
 * silence is the one outcome this page must not have. A sign-in pwiam itself
 * refuses (no tally role, a locked account) is explained on pwiam's own page
 * and never lands here.
 */
const ERRORS: Record<string, string> = {
  auth_failed: "Sign-in didn't complete. That usually means the page was opened in a different browser than the one that started it, or it sat too long — try again.",
};

export function Login() {
  const [loading, setLoading] = useState(false);
  const [params] = useSearchParams();
  const errorCode = params.get('error');
  const errorMessage = errorCode
    ? ERRORS[errorCode] ?? "Sign-in didn't complete. Try again, and if it keeps failing the error code was: " + errorCode
    : null;

  function handleLogin() {
    setLoading(true);
    // The shim starts the OIDC flow (PKCE + state cookie) and sends the
    // browser to pwiam, which offers the sign-in methods.
    window.location.href = '/api/auth/login';
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[100dvh] bg-[var(--color-bg)] px-6">
      <div className="flex flex-col items-center gap-6 max-w-sm w-full">
        {/* Logo */}
        <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--color-primary)] shadow-lg">
          <svg
            viewBox="0 0 100 100"
            className="w-8 h-8"
            fill="none"
            stroke="white"
            strokeWidth={6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="24" y="32" width="52" height="42" rx="5" />
            <line x1="24" y1="45" x2="76" y2="45" />
            <line x1="50" y1="32" x2="50" y2="45" />
          </svg>
        </div>

        <div className="text-center">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--color-text)]">Tally</h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">Home Inventory Management</p>
        </div>

        {/* role="alert" so it is announced on arrival — this page is reached
            BY the redirect that failed, so there is no interaction to attach
            the message to. */}
        {errorMessage && (
          <div
            role="alert"
            className="flex items-start gap-2 w-full rounded-[var(--radius-md)] border border-[var(--color-red)] bg-[var(--color-red-bg)] px-3 py-2.5 text-sm text-[var(--color-text)]"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-red)]" aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Login button */}
        <button
          onClick={handleLogin}
          disabled={loading}
          className="flex items-center justify-center gap-2 w-full px-6 py-3.5 bg-[var(--color-primary)] text-white rounded-[var(--radius-lg)] font-semibold hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-70"
        >
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Taking you to sign in...
            </>
          ) : (
            <>
              <LogIn className="w-5 h-5" />
              Sign in
            </>
          )}
        </button>

        {loading && (
          <p className="text-xs text-[var(--color-text-muted)] text-center animate-pulse">
            Redirecting to the sign-in page...
          </p>
        )}
      </div>
    </div>
  );
}
