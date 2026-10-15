import { useEffect, useState } from 'react';
import { completeLogin, loadConfig, login, logout, runtimeConfig } from './auth';
import { get } from './api';
import { Ask } from './views/Ask';
import { Costs } from './views/Costs';
import { Inventory } from './views/Inventory';
import { Knowledge } from './views/Knowledge';
import { Logs } from './views/Logs';
import { Reasoning } from './views/Reasoning';

const TABS = [
  { path: '/', label: 'Ask' },
  { path: '/knowledge', label: 'Project knowledge' },
  { path: '/inventory', label: 'Live inventory' },
  { path: '/reasoning', label: 'LLM reasoning logs' },
  { path: '/costs', label: 'Costs' },
  { path: '/logs', label: 'Logs explorer' },
] as const;

function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return [path, (p) => { window.history.pushState({}, '', p); setPath(p); window.scrollTo(0, 0); }];
}

export function App() {
  const [state, setState] = useState<'loading' | 'signed-out' | 'ready' | 'error'>('loading');
  const [user, setUser] = useState<string>();
  const [error, setError] = useState<string>();
  const [path, go] = usePath();

  useEffect(() => {
    (async () => {
      await loadConfig();
      if (!(await completeLogin())) return setState('signed-out');
      setUser((await get<{ username: string }>('/api/insights/me')).username);
      setState('ready');
    })().catch((e) => {
      if (e?.status === 401) return setState('signed-out');
      setError(e.message);
      setState('error');
    });
  }, []);

  if (state === 'loading') return <div className="center"><span className="spinner" /></div>;
  if (state === 'error') return <div className="center"><div className="alert bad">{error}</div></div>;
  if (state === 'signed-out') return <SignIn />;

  const tab = TABS.find((t) => t.path === path) ?? TABS[0];
  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => { e.preventDefault(); go('/'); }}>
          <span className="logo" aria-hidden>◎</span> Class Insights
        </a>
        <nav>
          {TABS.map((t) => (
            <a key={t.path} href={t.path} className={t === tab ? 'active' : ''} onClick={(e) => { e.preventDefault(); go(t.path); }}>{t.label}</a>
          ))}
        </nav>
        <div className="user">
          <a className="ext" href={runtimeConfig().workbenchUrl ?? '/'}>Claims Workbench ↗</a>
          <span className="user-name">{user}</span>
          <button className="link" onClick={logout}>Sign out</button>
        </div>
      </header>
      <main>
        {tab.path === '/' && <Ask />}
        {tab.path === '/knowledge' && <Knowledge />}
        {tab.path === '/inventory' && <Inventory />}
        {tab.path === '/reasoning' && <Reasoning />}
        {tab.path === '/costs' && <Costs />}
        {tab.path === '/logs' && <Logs />}
      </main>
    </div>
  );
}

function SignIn() {
  return (
    <div className="signin">
      <div className="signin-card">
        <div className="logo big" aria-hidden>◎</div>
        <h1>Class Insights</h1>
        <p className="muted">
          How the class's AI applications were designed and deployed, and what they are doing right now: architecture, AWS resources, live logs and the
          reasoning behind every LLM call.
        </p>
        <button className="primary wide" onClick={login}>Sign in with your class account</button>
        <p className="muted small">
          No account yet? Create one in the <a href={runtimeConfig().workbenchUrl ?? '/'}>Claims Intelligence Workbench</a>, then come back.
        </p>
      </div>
    </div>
  );
}
