export function Login() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[100dvh] bg-[var(--color-bg)] gap-6">
      <h1 className="text-2xl font-bold">Tally</h1>
      <p className="text-[var(--color-text-secondary)]">Home Inventory Management</p>
      <a href="/api/auth/_x_/oauth/init"
        className="px-6 py-3 bg-[var(--color-primary)] text-white rounded-[var(--radius-md)] font-medium hover:opacity-90 transition-opacity">
        Sign in with Microsoft
      </a>
    </div>
  );
}
