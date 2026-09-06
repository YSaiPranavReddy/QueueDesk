/**
 * ProtectedRoute — guards routes by auth state and role.
 *
 * Usage:
 *   <ProtectedRoute>               // requires any auth
 *   <ProtectedRoute role="agent">  // requires agent or admin
 *   <ProtectedRoute role="admin">  // requires admin only
 */
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const ROLE_HIERARCHY = { customer: 0, agent: 1, admin: 2 };

export default function ProtectedRoute({ children, role }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh' }}>
        <div className="spinner" style={{ width: 32, height: 32 }} />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (role) {
    const required = ROLE_HIERARCHY[role] ?? 0;
    const actual   = ROLE_HIERARCHY[user.role] ?? 0;
    if (actual < required) {
      // Redirect to their own home, not a 403 page
      return <Navigate to={`/${user.role}`} replace />;
    }
  }

  return children;
}
