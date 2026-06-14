import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface State {
  error: Error | null;
}

/**
 * Top-level boundary so a render-time error shows a recoverable screen instead
 * of a blank white page.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Unhandled render error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 min-h-[100dvh] p-6 text-center">
          <AlertTriangle className="w-10 h-10 text-[var(--color-red)]" />
          <div>
            <h1 className="text-base font-semibold text-[var(--color-text)]">Something went wrong</h1>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">Tally hit an unexpected error.</p>
          </div>
          <Button onClick={() => window.location.assign('/')}>Reload Tally</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
