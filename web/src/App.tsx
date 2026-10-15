import { type FormEvent, useEffect, useState } from 'react';
import { api } from './api';
import { completeLogin, loadConfig, login, logout, register, runtimeConfig, type UserType } from './auth';
import { Spinner } from './components/ui';
import { ClaimView } from './views/ClaimView';
import { HowItWorks } from './views/HowItWorks';
import { McpServers } from './views/McpServers';
import { Models } from './views/Models';
import { Queue } from './views/Queue';

export interface Me {
  username: string;
  groups: string[];
  isAnalyst: boolean;
  isSupervisor: boolean;
}

function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const go = (p: string) => {
    window.history.pushState({}, '', p);
    setPath(p);
    window.scrollTo(0, 0);
  };
  return [path, go];
}

export function App() {
  const [state, setState] = useState<'loading' | 'signed-out' | 'ready' | 'error'>('loading');
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState<string>();
  const [path, go] = usePath();
  const [liveModel, setLiveModel] = useState<string>();
  const refreshModel = () => {
    api.get<{ catalog: { models: { key: string; name: string }[] }; selection: { activeModel: string } }>('/api/models')
      .then((v) => setLiveModel(v.catalog.models.find((m) => m.key === v.selection.activeModel)?.name ?? v.selection.activeModel))
      .catch(() => {});
  };
  useEffect(() => {
    if (state !== 'ready') return;
    refreshModel();
    const t = setInterval(refreshModel, 30_000);
    return () => {
      clearInterval(t);
    };
  }, [state]);

  useEffect(() => {
    (async () => {
      await loadConfig();
      if (!(await completeLogin())) return setState('signed-out');
      setMe(await api.get<Me>('/api/me'));
      setState('ready');
    })().catch((e) => {
      if (e?.status === 401) return setState('signed-out');
      setError(e.message);
      setState('error');
    });
  }, []);

  if (state === 'loading') return <div className="center"><Spinner /></div>;
  if (state === 'error') return <div className="center"><div className="alert bad">{error}</div></div>;
  if (state === 'signed-out') return <SignIn />;

  const claimMatch = path.match(/^\/claims\/(CLM-\d{5})/);
  const nav = (p: string, label: string, active: boolean) => (
    <a href={p} className={active ? 'active' : ''} onClick={(e) => { e.preventDefault(); go(p); }}>
      {label}
    </a>
  );

  return (
    <div className="app">
      <div className="training-banner">Training demo · synthetic data only · not affiliated with any insurer or claims software vendor</div>
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => { e.preventDefault(); go('/'); }}>
          <span className="logo" aria-hidden>✓</span> Claims Intelligence Workbench
        </a>
        <nav>
          {nav('/', 'Work queue', path === '/' || !!claimMatch)}
          {nav('/mcp', 'MCP servers', path === '/mcp')}
          {nav('/models', 'Model routing', path === '/models')}
          {nav('/how', 'How it works', path === '/how')}
          {runtimeConfig().insightsUrl && (
            <a className="insights-link" href={runtimeConfig().insightsUrl}>Class Insights ↗</a>
          )}
        </nav>
        {liveModel && (
          <a href="/models" className="model-chip" title="LLM serving analyses now (AWS AppConfig) - click to change" onClick={(e) => { e.preventDefault(); go('/models'); }}>
            <span className="dot" aria-hidden /> {liveModel}
          </a>
        )}
        <div className="user">
          <span className="user-name">{me!.username}</span>
          <span className={`role ${me!.isSupervisor ? 'sup' : ''}`}>{me!.isSupervisor ? 'Supervisor' : me!.isAnalyst ? 'Analyst' : 'Viewer'}</span>
          <button className="link" onClick={logout}>Sign out</button>
        </div>
      </header>
      <main>
        {claimMatch ? (
          <ClaimView claimId={claimMatch[1]} me={me!} back={() => go('/')} />
        ) : path === '/mcp' ? (
          <McpServers />
        ) : path === '/models' ? (
          <Models onModelChange={refreshModel} />
        ) : path === '/how' ? (
          <HowItWorks />
        ) : (
          <Queue open={(id) => go(`/claims/${id}`)} />
        )}
      </main>
    </div>
  );
}

function SignIn() {
  const [mode, setMode] = useState<'choose' | 'register'>('choose');
  return (
    <div className="signin">
      <div className="signin-card">
        <div className="logo big" aria-hidden>✓</div>
        <h1>Claims Intelligence Workbench</h1>
        <p className="muted">AI-assisted review of auto physical-damage claims. Amazon Bedrock agent + two MCP servers on Amazon Bedrock AgentCore Runtime.</p>
        {mode === 'register' ? (
          <Register cancel={() => setMode('choose')} />
        ) : (
          <>
            <button className="primary wide" onClick={() => login()}>Sign in</button>
            {runtimeConfig().selfSignUp && <button className="ghost wide" onClick={() => setMode('register')}>Create an account</button>}
          </>
        )}
        {runtimeConfig().insightsUrl && (
          <a className="insights-cta" href={runtimeConfig().insightsUrl}>Class Insights: how this app was built, live logs and LLM reasoning ↗</a>
        )}
        <p className="muted small">Training demo · synthetic data only · not affiliated with any insurer or claims software vendor</p>
      </div>
    </div>
  );
}

const USER_TYPES: { value: UserType; label: string; detail: string }[] = [
  { value: 'analyst', label: 'Claims analyst', detail: 'Review claims and run AI analyses' },
  { value: 'supervisor', label: 'Claims supervisor', detail: 'Everything an analyst can do, plus approve, return or reject AI plans' },
];

function Register({ cancel }: { cancel: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [type, setType] = useState<UserType>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const valid = /^\S+$/.test(username) && password.length >= 6 && !!type;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    try {
      await register(username.trim(), password, type!);
      window.location.assign('/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="register" onSubmit={submit}>
      <h2>Create an account</h2>
      <p className="muted small">No email needed. You can create several accounts, e.g. one of each type.</p>
      <label>
        Username
        <input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username}
          onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))} placeholder="e.g. alex-supervisor" required />
      </label>
      <label>
        Password <span className="muted small">(any 6+ characters)</span>
        <input name="password" type="password" autoComplete="new-password" minLength={6} value={password}
          onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <fieldset>
        <legend>Type of user</legend>
        {USER_TYPES.map((t) => (
          <label key={t.value} className={`type-option ${type === t.value ? 'selected' : ''}`}>
            <input type="radio" name="userType" value={t.value} checked={type === t.value} onChange={() => setType(t.value)} />
            <span><strong>{t.label}</strong><span className="muted small">{t.detail}</span></span>
          </label>
        ))}
      </fieldset>
      {error && <div className="alert bad small">{error}</div>}
      <button className="primary wide" type="submit" disabled={!valid || busy}>{busy ? 'Creating account…' : 'Create account and sign in'}</button>
      <button className="link" type="button" onClick={cancel}>Back</button>
    </form>
  );
}
