import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

export function OAuthCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const error = params.get('error');

  useEffect(() => {
    // The server handles the OAuth callback and sets the cookie, so reaching
    // here without an error means the cookie is set and home is right.
    //
    // With an error it is not: this used to navigate to '/' regardless, where
    // root-layout bounced to /login for want of a session, and /login said
    // nothing — the user saw "Signing in…", then the sign-in button again
    // (#283). The provider names what went wrong in `?error=`; carrying it one
    // hop further is the whole fix, and /login knows how to say it.
    navigate(error ? `/login?error=${encodeURIComponent(error)}` : '/', { replace: true });
  }, [navigate, error]);

  return (
    <div className="flex items-center justify-center h-screen">
      <p className="text-[var(--color-text-muted)]">
        {error ? 'Sign-in failed — taking you back…' : 'Signing in...'}
      </p>
    </div>
  );
}
