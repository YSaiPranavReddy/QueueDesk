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
  const [showPwd, setShowPwd]   = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const EyeIcon = ({ visible }) => visible ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );

  const eyeStyle = {
    position: 'absolute', right: '0.75rem', top: '50%',
    transform: 'translateY(-50%)', background: 'none',
    border: 'none', cursor: 'pointer', color: 'var(--text-secondary)',
    padding: '0.25rem', display: 'flex', alignItems: 'center',
  };

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
                <div style={{ position: 'relative' }}>
                  <input
                    id="new-password"
                    type={showPwd ? 'text' : 'password'}
                    className="form-input"
                    style={{ paddingRight: '2.75rem' }}
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(''); }}
                    autoComplete="new-password"
                    required
                  />
                  <button type="button" aria-label={showPwd ? 'Hide' : 'Show'} style={eyeStyle} onClick={() => setShowPwd(v => !v)}>
                    <EyeIcon visible={showPwd} />
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="confirm-password">Confirm Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="confirm-password"
                    type={showConfirm ? 'text' : 'password'}
                    className={`form-input ${error === 'Passwords do not match' ? 'error' : ''}`}
                    style={{ paddingRight: '2.75rem' }}
                    placeholder="Repeat your new password"
                    value={confirm}
                    onChange={(e) => { setConfirm(e.target.value); setError(''); }}
                    autoComplete="new-password"
                    required
                  />
                  <button type="button" aria-label={showConfirm ? 'Hide' : 'Show'} style={eyeStyle} onClick={() => setShowConfirm(v => !v)}>
                    <EyeIcon visible={showConfirm} />
                  </button>
                </div>
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
