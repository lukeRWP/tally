import { useState } from 'react';
import { Loader2, LogIn, Package } from 'lucide-react';

export function Login() {
  const [loading, setLoading] = useState(false);

  function handleLogin() {
    setLoading(true);
    window.location.href = '/api/auth/_x_/oauth/init';
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[100dvh] bg-[var(--color-bg)] px-6">
      <div className="flex flex-col items-center gap-6 max-w-sm w-full">
        {/* Logo */}
        <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--color-primary)] shadow-lg">
          <Package className="w-8 h-8 text-white" />
        </div>

        <div className="text-center">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--color-text)]">Tally</h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">Home Inventory Management</p>
        </div>

        {/* Login button */}
        <button
          onClick={handleLogin}
          disabled={loading}
          className="flex items-center justify-center gap-2 w-full px-6 py-3.5 bg-[var(--color-primary)] text-white rounded-[var(--radius-lg)] font-semibold hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-70"
        >
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Connecting to Microsoft...
            </>
          ) : (
            <>
              <LogIn className="w-5 h-5" />
              Sign in with Microsoft
            </>
          )}
        </button>

        {loading && (
          <p className="text-xs text-[var(--color-text-muted)] text-center animate-pulse">
            Redirecting to Microsoft login...
          </p>
        )}
      </div>
    </div>
  );
}
