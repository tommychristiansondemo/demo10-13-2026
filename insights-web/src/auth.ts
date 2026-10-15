// Cognito managed login (authorization code + PKCE) on the class's shared user pool. Tokens live in sessionStorage.
export interface RuntimeConfig {
  localDev?: boolean;
  region?: string;
  siteUrl?: string;
  workbenchUrl?: string;
  cognitoDomain?: string;
  userPoolClientId?: string;
}

const TOKENS = 'ci.tokens';
const VERIFIER = 'ci.pkce';
let cfg: RuntimeConfig = {};

export async function loadConfig(): Promise<RuntimeConfig> {
  cfg = await (await fetch('/config.json', { cache: 'no-store' })).json();
  return cfg;
}
export const runtimeConfig = () => cfg;

const redirectUri = () => `${window.location.origin}/`;
const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function login(): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(VERIFIER, JSON.stringify({ verifier, state, path: window.location.pathname }));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ response_type: 'code', client_id: cfg.userPoolClientId!, redirect_uri: redirectUri(), scope: 'openid profile', state, code_challenge: challenge, code_challenge_method: 'S256' });
  window.location.assign(`${cfg.cognitoDomain}/oauth2/authorize?${q}`);
}

let completing: Promise<boolean> | undefined;
/** Memoized: React StrictMode runs effects twice and the code/verifier are single-use. */
export const completeLogin = () => (completing ??= doCompleteLogin());

async function doCompleteLogin(): Promise<boolean> {
  if (cfg.localDev) return true;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) {
    const saved = JSON.parse(sessionStorage.getItem(VERIFIER) ?? '{}') as { verifier?: string; state?: string; path?: string };
    sessionStorage.removeItem(VERIFIER);
    if (!saved.verifier || saved.state !== params.get('state')) throw new Error('Sign-in state mismatch, please try again.');
    const res = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.userPoolClientId!, code, redirect_uri: redirectUri(), code_verifier: saved.verifier }),
    });
    if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
    const t = await res.json();
    sessionStorage.setItem(TOKENS, JSON.stringify({ access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 }));
    window.history.replaceState({}, '', saved.path && saved.path !== '/' ? saved.path : '/');
  }
  return !!accessToken();
}

export function accessToken(): string | undefined {
  if (cfg.localDev) return 'local';
  const t = JSON.parse(sessionStorage.getItem(TOKENS) ?? 'null') as { access_token: string; expires_at: number } | null;
  return t && t.expires_at > Date.now() + 60_000 ? t.access_token : undefined;
}

export function logout(): void {
  sessionStorage.removeItem(TOKENS);
  const q = new URLSearchParams({ client_id: cfg.userPoolClientId!, logout_uri: redirectUri() });
  window.location.assign(`${cfg.cognitoDomain}/logout?${q}`);
}
