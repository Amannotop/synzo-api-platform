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
import Playground from './pages/Playground';
import Operations from './pages/Operations';
import Settings from './pages/Settings';
import Admin from './pages/Admin';
import NotFound from './pages/NotFound';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';

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
      {/* Reachable signed-out: these are the landing pages for the links in a
          reset or verification email, so they must render without a session. */}
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
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
        {/* The API serves its own interactive reference at /docs, so the
            hand-written page is now /documentation and links across to it.
            Keeping the dashboard's own /docs path would shadow the API's. */}
        <Route path="/documentation" element={<Documentation />} />
        <Route path="/playground" element={<Playground />} />
        <Route path="/settings" element={<Settings />} />
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <Admin />
            </RequireAdmin>
          }
        />
        <Route
          path="/operations"
          element={
            <RequireAdmin>
              <Operations />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
