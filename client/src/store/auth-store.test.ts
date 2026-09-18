// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The store applies the theme at import time and reads matchMedia for it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
});

const { useAuthStore } = await import('./auth-store');

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('auth-store against @pw/auth-express', () => {
  const fetchMock = vi.fn();
  const assign = vi.fn();
  const realLocation = window.location;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    assign.mockReset();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
    useAuthStore.setState({ user: null, isLoading: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    document.cookie = 'csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  it('checkSession reads the shim\'s { user } body (not the { success, data } envelope)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: 4, email: 'a@b.test', displayName: 'Ada', avatarUrl: null }, auth: { sub: 'x' } }));
    await useAuthStore.getState().checkSession();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/session');
    expect(init.credentials).toBe('include');
    expect(useAuthStore.getState().user?.displayName).toBe('Ada');
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it('checkSession treats the shim\'s 401 as signed out', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized', loginUrl: '/api/auth/login' }, 401));
    await useAuthStore.getState().checkSession();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it('logout POSTs with the CSRF header, clears the user, and follows the issuer\'s end-session redirect', async () => {
    document.cookie = 'csrf_token=tok-1';
    useAuthStore.setState({ user: { id: 4, email: 'a@b.test', displayName: 'Ada', avatarUrl: null } });
    fetchMock.mockResolvedValue(jsonResponse({ redirect: 'https://id.test/session/end?id_token_hint=x' }));

    await useAuthStore.getState().logout();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/logout');
    expect(init.method).toBe('POST');
    expect(init.headers['X-CSRF-Token']).toBe('tok-1');
    expect(useAuthStore.getState().user).toBeNull();
    expect(assign).toHaveBeenCalledWith('https://id.test/session/end?id_token_hint=x');
  });

  it('logout lands on /login when the server cannot be reached', async () => {
    useAuthStore.setState({ user: { id: 4, email: 'a@b.test', displayName: 'Ada', avatarUrl: null } });
    fetchMock.mockRejectedValue(new Error('offline'));

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState().user).toBeNull();
    expect(assign).toHaveBeenCalledWith('/login');
  });
});
