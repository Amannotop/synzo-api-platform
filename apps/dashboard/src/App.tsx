import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/AuthContext';
import AppLayout from './components/AppLayout';
import SignIn from './pages/SignIn';
import Dashboard from './pages/Dashboard';
import ApiKeys from './pages/ApiKeys';
import Projects from './pages/Projects';
import Models from './pages/Models';
import Usage from './pages/Usage';
import Requests from './pages/Requests';
import Documentation from './pages/Documentation';
import Settings from './pages/Settings';
import Admin from './pages/Admin';
import NotFound from './pages/NotFound';

/** Blocks a route until the session is known, so we never flash the login
 *  screen at a customer who is already signed in. */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="auth-wrap">
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <div className="spinner" style={{ color: 'var(--accent)' }} />
          <p className="muted small mt-2">Loading your workspace…</p>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/signin" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/signin"
        element={loading ? null : user ? <Navigate to="/" replace /> : <SignIn />}
      />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/keys" element={<ApiKeys />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/models" element={<Models />} />
        <Route path="/usage" element={<Usage />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/docs" element={<Documentation />} />
        <Route path="/settings" element={<Settings />} />
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <Admin />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
