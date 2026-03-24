import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export function OAuthCallback() {
  const navigate = useNavigate();

  useEffect(() => {
    // The server handles the OAuth callback and sets the cookie.
    // By the time the user reaches this page, the cookie is set.
    // Just redirect to home.
    navigate('/', { replace: true });
  }, [navigate]);

  return (
    <div className="flex items-center justify-center h-screen">
      <p className="text-[var(--color-text-muted)]">Signing in...</p>
    </div>
  );
}
