/**
 * VerifyEmailPage — handles /verify-email?token=... link from verification email.
 * Calls the server to validate the token and marks the user as verified.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '../api/auth.js';
import './AuthPage.css';

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate       = useNavigate();
  const token          = searchParams.get('token');

  const [status, setStatus] = useState('loading'); // 'loading' | 'success' | 'error'
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('No verification token found. Please use the link from your email.');
      return;
    }

    authApi.verifyEmail(token)
      .then(() => {
        setStatus('success');
        setMessage('Your email has been verified! Redirecting to login…');
        setTimeout(() => navigate('/login'), 3000);
      })
      .catch((err) => {
        setStatus('error');
        setMessage(err.response?.data?.message || 'This link is invalid or has expired. Please request a new verification email from your dashboard.');
      });
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="auth-layout">
      <div className="auth-background" aria-hidden="true" />
      <div className="auth-orb auth-orb-1" />
      <div className="auth-orb auth-orb-2" />
      <div className="auth-orb auth-orb-3" />

      <div className="auth-brand">
        <div className="auth-brand-inner animate-fadeUp">
          <div className="auth-logo">
            <img src="/logo.png" alt="QueueDesk logo" className="auth-logo-icon" />
            <span className="auth-logo-text">Queue<span className="auth-logo-text-accent">Desk</span></span>
          </div>
          <h1 className="auth-tagline">
            {status === 'success' ? 'You\'re verified!' : 'Email Verification'}
          </h1>
          <p className="auth-description">
            {status === 'success'
              ? 'Your account is now fully activated.'
              : 'We\'re verifying your email address…'}
          </p>
        </div>
      </div>

      <div className="auth-panel">
        <div className="auth-card animate-fadeUp">
          <div className="auth-card-header">
            <div className="auth-logo auth-logo-mobile">
              <img src="/logo.png" alt="QueueDesk logo" className="auth-logo-icon auth-logo-icon-sm" />
              <span className="auth-logo-text">QueueDesk</span>
            </div>
            <h2 className="auth-card-title">Email Verification</h2>
          </div>

          <div style={{ textAlign: 'center', padding: '2rem 0' }}>
            {status === 'loading' && (
              <>
                <div className="spinner" style={{ width: '2.5rem', height: '2.5rem', margin: '0 auto 1.5rem', borderWidth: '3px' }} />
                <div className="text-sm text-secondary">Verifying your email address…</div>
              </>
            )}

            {status === 'success' && (
              <>
                <div style={{ fontSize: '3.5rem', marginBottom: '1rem' }}>✅</div>
                <div className="font-semibold" style={{ color: 'var(--text-primary)', marginBottom: '0.5rem', fontSize: '1.1rem' }}>
                  Email verified!
                </div>
                <div className="text-sm text-secondary" style={{ marginBottom: '1.5rem' }}>{message}</div>
                <button className="btn btn-primary btn-lg w-full" onClick={() => navigate('/login')}>
                  Go to Sign In
                </button>
              </>
            )}

            {status === 'error' && (
              <>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>❌</div>
                <div className="font-semibold" style={{ color: '#f87171', marginBottom: '0.75rem' }}>
                  Verification failed
                </div>
                <div className="text-sm text-secondary" style={{ marginBottom: '1.5rem' }}>{message}</div>
                <button className="btn btn-primary btn-lg w-full" onClick={() => navigate('/login')}>
                  Back to Sign In
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
