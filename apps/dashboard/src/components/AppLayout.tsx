import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { useTheme } from '../lib/ThemeContext';
import { Avatar, Icons } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: Icons.dashboard, end: true },
  { to: '/keys', label: 'API Keys', icon: Icons.key },
  { to: '/projects', label: 'Projects', icon: Icons.folder },
  { to: '/models', label: 'Models', icon: Icons.cube },
  { to: '/usage', label: 'Usage', icon: Icons.chart },
  { to: '/credits', label: 'Credits', icon: Icons.wallet },
  { to: '/requests', label: 'Requests', icon: Icons.list },
  { to: '/playground', label: 'Playground', icon: Icons.terminal },
  { to: '/documentation', label: 'Documentation', icon: Icons.book },
  { to: '/settings', label: 'Settings', icon: Icons.settings },
];

const ADMIN_NAV = [
  { to: '/admin', label: 'Admin', icon: Icons.shield },
  { to: '/admin/credits', label: 'Credits & billing', icon: Icons.wallet },
  { to: '/operations', label: 'Operations', icon: Icons.chart },
];

const TITLES: Record<string, string> = {
  '/': 'Dashboard', '/keys': 'API Keys', '/projects': 'Projects', '/models': 'Models',
  '/usage': 'Usage', '/credits': 'Credits', '/requests': 'Requests',
  '/documentation': 'Documentation',
  '/playground': 'Playground',
  '/settings': 'Settings', '/admin': 'Admin', '/admin/credits': 'Credits & billing',
  '/operations': 'Operations',
};

export default function AppLayout() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  // Close the drawer on navigation so a tap does not leave it covering content.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const isAdmin = user?.role === 'admin';
  const title = TITLES[location.pathname] ?? 'Synzo API';

  return (
    <div className="app">
      {navOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}

      <aside className={`sidebar ${navOpen ? 'open' : ''}`} aria-label="Main navigation">
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">S</div>
          <span className="brand-text">Synzo API</span>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <item.icon size={16} />
              {item.label}
            </NavLink>
          ))}

          {isAdmin && (
            <>
              <div className="nav-section">Administration</div>
              {ADMIN_NAV.map((item) => (
                <NavLink key={item.to} to={item.to}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                  <item.icon size={16} />
                  {item.label}
                </NavLink>
              ))}
            </>
          )}
        </nav>

        {user && (
          <div className="sidebar-footer">
            <Avatar name={user.name} />
            <div className="sidebar-user">
              <div className="sidebar-user-name">{user.name}</div>
              <div className="sidebar-user-mail">{user.email}</div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => void logout()} aria-label="Sign out"
              title="Sign out">
              <Icons.logout size={15} />
            </button>
          </div>
        )}
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Icons.menu size={17} />
          </button>
          <div className="topbar-title">{title}</div>
          <button className="btn btn-ghost btn-sm" onClick={toggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? <Icons.sun size={15} /> : <Icons.moon size={15} />}
          </button>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
