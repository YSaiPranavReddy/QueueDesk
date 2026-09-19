/**
 * ResetPasswordPage — handles the /reset-password?token=... link from email.
 * Reads token from URL, lets user enter a new password, calls the API.
 */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '../api/auth.js';
import './AuthPage.css';

export default function ResetPasswordPage() {
  const [searchParams]      = useSearchParams();
  const navigate            = useNavigate();
  const token               = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState(false);
  const [loading, setLoading]   = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Password must be at least 8 characters');
    if (password !== confirm) return setError('Passwords do not match');
    if (!token) return setError('Invalid or missing reset token. Please request a new link.');

    setLoading(true);
    try {
      await authApi.resetPassword(token, password);
      setSuccess(true);
      // Redirect to login after 3 seconds
      setTimeout(() => navigate('/login'), 3000);
    } catch (err) {
      setError(err.response?.data?.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-layout">
      <div className="auth-background" aria-hidden="true" />
      <div className="auth-orb auth-orb-1" />
      <div className="auth-orb auth-orb-2" />
      <div className="auth-orb auth-orb-3" />

      {/* Brand */}
      <div className="auth-brand">
        <div className="auth-brand-inner animate-fadeUp">
          <div className="auth-logo">
            <img src="/logo.png" alt="QueueDesk logo" className="auth-logo-icon" />
            <span className="auth-logo-text">Queue<span className="auth-logo-text-accent">Desk</span></span>
          </div>
          <h1 className="auth-tagline">
            Secure your<br />
            <span className="auth-tagline-accent">account.</span>
          </h1>
          <p className="auth-description">
            Choose a strong, unique password to keep your account safe.
          </p>
        </div>
      </div>

      {/* Card */}
      <div className="auth-panel">
        <div className="auth-card animate-fadeUp">
          <div className="auth-card-header">
            <div className="auth-logo auth-logo-mobile">
              <img src="/logo.png" alt="QueueDesk logo" className="auth-logo-icon auth-logo-icon-sm" />
              <span className="auth-logo-text">QueueDesk</span>
            </div>
            <h2 className="auth-card-title">
              {success ? 'Password updated!' : 'Set new password'}
            </h2>
            <p className="auth-card-subtitle text-secondary">
              {success
                ? 'Redirecting you to sign in…'
                : 'Enter a new password for your account'}
            </p>
          </div>

          {success ? (
            <div style={{ textAlign: 'center', padding: '2rem 0' }}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✅</div>
              <div className="text-sm text-secondary">Your password has been changed. You will be redirected to the login page in a moment.</div>
              <button
                className="btn btn-primary btn-lg w-full"
                style={{ marginTop: '1.5rem' }}
                onClick={() => navigate('/login')}
              >
                Go to Sign In
              </button>
            </div>
          ) : !token ? (
            <div style={{ textAlign: 'center', padding: '2rem 0' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>⚠️</div>
              <div className="text-sm text-secondary" style={{ marginBottom: '1.5rem' }}>
                This reset link is invalid or has already been used.
              </div>
              <button className="btn btn-primary btn-lg w-full" onClick={() => navigate('/login')}>
                Back to Sign In
              </button>
            </div>
          ) : (
            <form className="auth-form" onSubmit={handleSubmit} noValidate>
              <div className="form-group">
                <label className="form-label" htmlFor="new-password">New Password</label>
                <input
                  id="new-password"
                  type="password"
                  className="form-input"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  autoComplete="new-password"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="confirm-password">Confirm Password</label>
                <input
                  id="confirm-password"
                  type="password"
                  className={`form-input ${error === 'Passwords do not match' ? 'error' : ''}`}
                  placeholder="Repeat your new password"
                  value={confirm}
                  onChange={(e) => { setConfirm(e.target.value); setError(''); }}
                  autoComplete="new-password"
                  required
                />
              </div>

              {error && (
                <div className="auth-error" role="alert">
                  <span className="auth-error-icon">⚠</span>
                  {error}
                </div>
              )}

              <button
                id="reset-submit"
                type="submit"
                className="btn btn-primary btn-lg w-full"
                disabled={loading}
              >
                {loading ? <><div className="spinner" /> Updating password…</> : 'Set New Password'}
              </button>

              <div style={{ textAlign: 'center', marginTop: '1rem' }}>
                <button type="button" className="auth-switch-btn" onClick={() => navigate('/login')}>
                  ← Back to sign in
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
