// Cognito managed login (authorization code + PKCE). Tokens live in sessionStorage only for this tab.
export interface RuntimeConfig {
  localDev?: boolean;
  region?: string;
  siteUrl?: string;
  cognitoDomain?: string;
  userPoolClientId?: string;
  selfSignUp?: boolean;
  insightsUrl?: string;
}

const TOKENS = 'cwb.tokens';
const VERIFIER = 'cwb.pkce';

interface Tokens {
  access_token: string;
  id_token: string;
  expires_at: number;
}

let cfg: RuntimeConfig = {};

export async function loadConfig(): Promise<RuntimeConfig> {
  cfg = await (await fetch('/config.json', { cache: 'no-store' })).json();
  return cfg;
}

const redirectUri = () => `${window.location.origin}/`;

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login(signup = false): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(VERIFIER, JSON.stringify({ verifier, state, path: window.location.pathname }));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.userPoolClientId!,
    redirect_uri: redirectUri(),
    scope: 'openid profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.assign(`${cfg.cognitoDomain}/${signup ? 'signup' : 'oauth2/authorize'}?${q}`);
}

let completing: Promise<boolean> | undefined;

/** Completes the redirect from Cognito if ?code= is present. Returns true when a session exists.
 *  Memoized: React StrictMode runs effects twice and the code/verifier are single-use. */
export function completeLogin(): Promise<boolean> {
  return (completing ??= doCompleteLogin());
}

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
    sessionStorage.setItem(TOKENS, JSON.stringify({ access_token: t.access_token, id_token: t.id_token, expires_at: Date.now() + t.expires_in * 1000 }));
    window.history.replaceState({}, '', saved.path && saved.path !== '/' ? saved.path : '/');
  }
  return !!accessToken();
}

export type UserType = 'analyst' | 'supervisor';

/** Cognito user-pool API (public client, no secret): https://cognito-idp.<region>.amazonaws.com */
async function idp<T>(target: string, body: object): Promise<T> {
  const res = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(cognitoMessage(data));
  return data as T;
}

function cognitoMessage(e: { __type?: string; message?: string }): string {
  const type = (e.__type ?? '').split('#').pop();
  if (type === 'UsernameExistsException') return 'That username is taken. Pick another one.';
  if (type === 'InvalidPasswordException') return 'Password must be at least 6 characters.';
  if (type === 'UserLambdaValidationException') return (e.message ?? '').replace(/^PreSignUp failed with error /, '');
  return e.message ?? 'Request failed';
}

/** Student self-registration: create the user (auto-confirmed, placed in the group for the chosen type), then sign in. */
export async function register(username: string, password: string, type: UserType): Promise<void> {
  await idp('SignUp', { ClientId: cfg.userPoolClientId, Username: username, Password: password, ClientMetadata: { role: type } });
  const r = await idp<{ AuthenticationResult?: { AccessToken: string; IdToken: string; ExpiresIn: number } }>('InitiateAuth', {
    ClientId: cfg.userPoolClientId,
    AuthFlow: 'USER_AUTH',
    AuthParameters: { USERNAME: username, PASSWORD: password, PREFERRED_CHALLENGE: 'PASSWORD' },
  });
  const t = r.AuthenticationResult;
  if (!t) throw new Error('Account created, but sign-in needs another step. Use Sign in.');
  sessionStorage.setItem(TOKENS, JSON.stringify({ access_token: t.AccessToken, id_token: t.IdToken, expires_at: Date.now() + t.ExpiresIn * 1000 }));
}

export function accessToken(): string | undefined {
  if (cfg.localDev) return 'local';
  const t = JSON.parse(sessionStorage.getItem(TOKENS) ?? 'null') as Tokens | null;
  if (!t || t.expires_at < Date.now() + 60_000) return undefined;
  return t.access_token;
}

export function logout(): void {
  sessionStorage.removeItem(TOKENS);
  if (cfg.localDev) return window.location.reload();
  const q = new URLSearchParams({ client_id: cfg.userPoolClientId!, logout_uri: redirectUri() });
  window.location.assign(`${cfg.cognitoDomain}/logout?${q}`);
}

export const runtimeConfig = () => cfg;
