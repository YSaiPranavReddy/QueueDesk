/**
 * AuthPage — Login & Register in a single animated view.
 * Toggle between modes without a route change.
 *
 * Design: dark glassmorphism card, animated gradient orbs, role selector tabs.
 */
import { useRef, useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { authApi } from '../api/auth.js';
import './AuthPage.css';

const DEFAULT_COLOR = '#ffffff';

const hexToRgb = (hex) => {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return match
    ? [
        parseInt(match[1], 16) / 255,
        parseInt(match[2], 16) / 255,
        parseInt(match[3], 16) / 255,
      ]
    : [1, 1, 1];
};

const getAnchorAndDir = (origin, w, h) => {
  const outside = 0.2;
  switch (origin) {
    case 'top-left':
      return { anchor: [0, -outside * h], dir: [0, 1] };
    case 'top-right':
      return { anchor: [w, -outside * h], dir: [0, 1] };
    case 'left':
      return { anchor: [-outside * w, 0.5 * h], dir: [1, 0] };
    case 'right':
      return { anchor: [(1 + outside) * w, 0.5 * h], dir: [-1, 0] };
    case 'bottom-left':
      return { anchor: [0, (1 + outside) * h], dir: [0, -1] };
    case 'bottom-center':
      return { anchor: [0.5 * w, (1 + outside) * h], dir: [0, -1] };
    case 'bottom-right':
      return { anchor: [w, (1 + outside) * h], dir: [0, -1] };
    default:
      return { anchor: [0.5 * w, -outside * h], dir: [0, 1] };
  }
};

const LightRays = ({
  raysOrigin = 'top-center',
  raysColor = DEFAULT_COLOR,
  raysSpeed = 1,
  lightSpread = 1,
  rayLength = 2,
  pulsating = false,
  fadeDistance = 1.0,
  saturation = 1.0,
  followMouse = true,
  mouseInfluence = 0.12,
  noiseAmount = 0.0,
  distortion = 0.0,
  lightMode = false,
  className = '',
}) => {
  const containerRef = useRef(null);
  const uniformsRef = useRef(null);
  const rendererRef = useRef(null);
  const mouseRef = useRef({ x: 0.5, y: 0.5 });
  const smoothMouseRef = useRef({ x: 0.5, y: 0.5 });
  const animationIdRef = useRef(null);
  const meshRef = useRef(null);
  const cleanupFunctionRef = useRef(null);
  const [isVisible, setIsVisible] = useState(false);
  const observerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0.1 }
    );

    observerRef.current.observe(containerRef.current);

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isVisible || !containerRef.current) return;

    if (cleanupFunctionRef.current) {
      cleanupFunctionRef.current();
      cleanupFunctionRef.current = null;
    }

    const initializeWebGL = async () => {
      if (!containerRef.current) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (!containerRef.current) return;

      const { Renderer, Program, Triangle, Mesh } = await import('ogl');

      const renderer = new Renderer({ dpr: Math.min(window.devicePixelRatio, 2), alpha: true });
      rendererRef.current = renderer;

      const gl = renderer.gl;
      gl.canvas.style.width = '100%';
      gl.canvas.style.height = '100%';

      while (containerRef.current.firstChild) {
        containerRef.current.removeChild(containerRef.current.firstChild);
      }
      containerRef.current.appendChild(gl.canvas);

      const vert = `
        attribute vec2 position;
        varying vec2 vUv;
        void main() {
          vUv = position * 0.5 + 0.5;
          gl_Position = vec4(position, 0.0, 1.0);
        }
      `;

      const frag = `
        precision highp float;
        uniform float iTime;
        uniform vec2 iResolution;
        uniform vec2 rayPos;
        uniform vec2 rayDir;
        uniform vec3 raysColor;
        uniform float raysSpeed;
        uniform float lightSpread;
        uniform float rayLength;
        uniform float pulsating;
        uniform float fadeDistance;
        uniform float saturation;
        uniform vec2 mousePos;
        uniform float mouseInfluence;
        uniform float noiseAmount;
        uniform float distortion;
        uniform float lightMode;
        varying vec2 vUv;

        float noise(vec2 st) {
          return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
        }

        float rayStrength(vec2 raySource, vec2 rayRefDirection, vec2 coord, float seedA, float seedB, float speed) {
          vec2 sourceToCoord = coord - raySource;
          vec2 dirNorm = normalize(sourceToCoord);
          float cosAngle = dot(dirNorm, rayRefDirection);
          float distortedAngle = cosAngle + distortion * sin(iTime * 2.0 + length(sourceToCoord) * 0.01) * 0.2;
          float spreadFactor = pow(max(distortedAngle, 0.0), 1.0 / max(lightSpread, 0.001));
          float distance = length(sourceToCoord);
          float maxDistance = iResolution.x * rayLength;
          float lengthFalloff = clamp((maxDistance - distance) / maxDistance, 0.0, 1.0);
          float fadeFalloff = clamp((iResolution.x * fadeDistance - distance) / (iResolution.x * fadeDistance), 0.5, 1.0);
          float pulse = pulsating > 0.5 ? (0.8 + 0.2 * sin(iTime * speed * 3.0)) : 1.0;
          float baseStrength = clamp(
            (0.45 + 0.15 * sin(distortedAngle * seedA + iTime * speed)) +
            (0.3 + 0.2 * cos(-distortedAngle * seedB + iTime * speed)),
            0.0,
            1.0
          );

          return baseStrength * lengthFalloff * fadeFalloff * spreadFactor * pulse;
        }

        void mainImage(out vec4 fragColor, in vec2 fragCoord) {
          vec2 coord = vec2(fragCoord.x, iResolution.y - fragCoord.y);
          vec2 finalRayDir = rayDir;

          if (mouseInfluence > 0.0) {
            vec2 mouseScreenPos = mousePos * iResolution.xy;
            vec2 mouseDirection = normalize(mouseScreenPos - rayPos);
            finalRayDir = normalize(mix(rayDir, mouseDirection, mouseInfluence));
          }

          vec4 rays1 = vec4(1.0) * rayStrength(rayPos, finalRayDir, coord, 36.2214, 21.11349, 1.5 * raysSpeed);
          vec4 rays2 = vec4(1.0) * rayStrength(rayPos, finalRayDir, coord, 22.3991, 18.0234, 1.1 * raysSpeed);

          fragColor = rays1 * 0.5 + rays2 * 0.4;

          if (noiseAmount > 0.0) {
            float n = noise(coord * 0.01 + iTime * 0.1);
            fragColor.rgb *= (1.0 - noiseAmount + noiseAmount * n);
          }

          float brightness = 1.0 - (coord.y / iResolution.y);
          fragColor.x *= 0.1 + brightness * 0.8;
          fragColor.y *= 0.3 + brightness * 0.6;
          fragColor.z *= 0.5 + brightness * 0.5;

          if (saturation != 1.0) {
            float gray = dot(fragColor.rgb, vec3(0.299, 0.587, 0.114));
            fragColor.rgb = mix(vec3(gray), fragColor.rgb, saturation);
          }

          fragColor.rgb *= raysColor;

          if (lightMode > 0.5) {
            vec3 mapped = vec3(1.0) - exp(-max(fragColor.rgb, vec3(0.0)) * 1.35);
            float energy = clamp(max(mapped.r, max(mapped.g, mapped.b)), 0.0, 1.0);
            vec3 hue = mapped / max(energy, 0.0001);
            vec3 ink = mix(hue * 0.25, hue * 0.72, energy);
            fragColor = vec4(mix(vec3(1.0), ink, energy), 1.0);
          }
        }

        void main() {
          vec4 color;
          mainImage(color, gl_FragCoord.xy);
          gl_FragColor = color;
        }
      `;

      const uniforms = {
        iTime: { value: 0 },
        iResolution: { value: [1, 1] },
        rayPos: { value: [0, 0] },
        rayDir: { value: [0, 1] },
        raysColor: { value: hexToRgb(raysColor) },
        raysSpeed: { value: raysSpeed },
        lightSpread: { value: lightSpread },
        rayLength: { value: rayLength },
        pulsating: { value: pulsating ? 1.0 : 0.0 },
        fadeDistance: { value: fadeDistance },
        saturation: { value: saturation },
        mousePos: { value: [0.5, 0.5] },
        mouseInfluence: { value: mouseInfluence },
        noiseAmount: { value: noiseAmount },
        distortion: { value: distortion },
        lightMode: { value: lightMode ? 1.0 : 0.0 },
      };
      uniformsRef.current = uniforms;

      const geometry = new Triangle(gl);
      const program = new Program(gl, { vertex: vert, fragment: frag, uniforms });
      const mesh = new Mesh(gl, { geometry, program });
      meshRef.current = mesh;

      const updatePlacement = () => {
        if (!containerRef.current || !renderer) return;
        renderer.dpr = Math.min(window.devicePixelRatio, 2);

        const { clientWidth: wCSS, clientHeight: hCSS } = containerRef.current;
        renderer.setSize(wCSS, hCSS);

        const dpr = renderer.dpr;
        const w = wCSS * dpr;
        const h = hCSS * dpr;

        uniforms.iResolution.value = [w, h];
        const { anchor, dir } = getAnchorAndDir(raysOrigin, w, h);
        uniforms.rayPos.value = anchor;
        uniforms.rayDir.value = dir;
      };

      const loop = (t) => {
        if (!rendererRef.current || !uniformsRef.current || !meshRef.current) return;
        uniforms.iTime.value = t * 0.001;

        if (followMouse && mouseInfluence > 0.0) {
          const smoothing = 0.92;
          smoothMouseRef.current.x = smoothMouseRef.current.x * smoothing + mouseRef.current.x * (1 - smoothing);
          smoothMouseRef.current.y = smoothMouseRef.current.y * smoothing + mouseRef.current.y * (1 - smoothing);
          uniforms.mousePos.value = [smoothMouseRef.current.x, smoothMouseRef.current.y];
        }

        try {
          renderer.render({ scene: mesh });
          animationIdRef.current = requestAnimationFrame(loop);
        } catch (error) {
          console.warn('WebGL rendering error:', error);
          return;
        }
      };

      window.addEventListener('resize', updatePlacement);
      updatePlacement();
      animationIdRef.current = requestAnimationFrame(loop);

      cleanupFunctionRef.current = () => {
        if (animationIdRef.current) {
          cancelAnimationFrame(animationIdRef.current);
          animationIdRef.current = null;
        }

        window.removeEventListener('resize', updatePlacement);

        if (renderer) {
          try {
            const canvas = renderer.gl.canvas;
            const loseContextExt = renderer.gl.getExtension('WEBGL_lose_context');
            if (loseContextExt) loseContextExt.loseContext();
            if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
          } catch (error) {
            console.warn('Error during WebGL cleanup:', error);
          }
        }

        rendererRef.current = null;
        uniformsRef.current = null;
        meshRef.current = null;
      };
    };

    initializeWebGL();

    return () => {
      if (cleanupFunctionRef.current) {
        cleanupFunctionRef.current();
        cleanupFunctionRef.current = null;
      }
    };
  }, [
    isVisible,
    raysOrigin,
    raysColor,
    raysSpeed,
    lightSpread,
    rayLength,
    pulsating,
    fadeDistance,
    saturation,
    followMouse,
    mouseInfluence,
    noiseAmount,
    distortion,
    lightMode,
  ]);

  useEffect(() => {
    if (!uniformsRef.current || !containerRef.current || !rendererRef.current) return;

    const u = uniformsRef.current;
    const renderer = rendererRef.current;
    u.raysColor.value = hexToRgb(raysColor);
    u.raysSpeed.value = raysSpeed;
    u.lightSpread.value = lightSpread;
    u.rayLength.value = rayLength;
    u.pulsating.value = pulsating ? 1.0 : 0.0;
    u.fadeDistance.value = fadeDistance;
    u.saturation.value = saturation;
    u.mouseInfluence.value = mouseInfluence;
    u.noiseAmount.value = noiseAmount;
    u.distortion.value = distortion;
    u.lightMode.value = lightMode ? 1.0 : 0.0;

    const { clientWidth: wCSS, clientHeight: hCSS } = containerRef.current;
    const dpr = renderer.dpr;
    const { anchor, dir } = getAnchorAndDir(raysOrigin, wCSS * dpr, hCSS * dpr);
    u.rayPos.value = anchor;
    u.rayDir.value = dir;
  }, [
    raysColor,
    raysSpeed,
    lightSpread,
    raysOrigin,
    rayLength,
    pulsating,
    fadeDistance,
    saturation,
    mouseInfluence,
    noiseAmount,
    distortion,
    lightMode,
  ]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!containerRef.current || !rendererRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      mouseRef.current = { x, y };
    };

    if (followMouse) {
      window.addEventListener('mousemove', handleMouseMove);
      return () => window.removeEventListener('mousemove', handleMouseMove);
    }
  }, [followMouse]);

  return (
    <div
      ref={containerRef}
      className={`w-full h-full pointer-events-none overflow-hidden relative ${className}`.trim()}
    />
  );
};

const ROLES = [
  { id: 'customer', label: 'Customer',  icon: '👤' },
  { id: 'agent',    label: 'Agent',     icon: '🎧' },
];

export default function AuthPage() {
  const { login } = useAuth();

  const [mode, setMode]       = useState('login');   // 'login' | 'register'
  const [role, setRole]       = useState('customer');
  const [form, setForm]       = useState({ name: '', email: '', password: '' });
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  const isRegister = mode === 'register';

  const handleChange = (e) => {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      let res;
      if (isRegister) {
        if (!form.name.trim()) return setError('Name is required');
        if (form.password.length < 8) return setError('Password must be at least 8 characters');
        res = await authApi.register({ ...form, role });
      } else {
        res = await authApi.login({ email: form.email, password: form.password });
      }
      const { accessToken, user } = res.data;
      login(accessToken, user);
    } catch (err) {
      const msg = err.response?.data?.message || 'Something went wrong. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const switchMode = () => {
    setMode((m) => (m === 'login' ? 'register' : 'login'));
    setError('');
    setForm({ name: '', email: '', password: '' });
  };

  return (
    <div className="auth-layout">
      <div className="auth-background" aria-hidden="true">
        <LightRays
          raysOrigin="top-center"
          raysColor="#b8d7ff"
          raysSpeed={1.1}
          lightSpread={1.2}
          rayLength={1.7}
          pulsating={true}
          fadeDistance={1.25}
          saturation={1.2}
          followMouse={true}
          mouseInfluence={0.15}
          noiseAmount={0.08}
          distortion={0.2}
          lightMode={false}
          className="auth-light-rays"
        />
      </div>

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
            Support at the<br />
            <span className="auth-tagline-accent">speed of real-time.</span>
          </h1>
          <p className="auth-description">
            Customer support infrastructure that actually scales.
          </p>

          <div className="auth-features">
            {[
              { icon: '⚡', text: 'Instant agent matching via atomic Redis ops' },
              { icon: '📡', text: 'Live queue position via WebSocket push' },
              { icon: '⏱️', text: 'SLA auto-escalation on stale tickets' },
            ].map(({ icon, text }) => (
              <div className="auth-feature-item" key={text}>
                <span className="auth-feature-icon">{icon}</span>
                <span>{text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="auth-panel">
        <div className="auth-card animate-fadeUp">
          {/* Header */}
          <div className="auth-card-header">
            <div className="auth-logo auth-logo-mobile">
              <img src="/logo.png" alt="QueueDesk logo" className="auth-logo-icon auth-logo-icon-sm" />
              <span className="auth-logo-text">QueueDesk</span>
            </div>
            <h2 className="auth-card-title">
              {isRegister ? 'Create your account' : 'Welcome back'}
            </h2>
            <p className="auth-card-subtitle text-secondary">
              {isRegister
                ? 'Join QueueDesk and start managing support'
                : 'Sign in to continue to your dashboard'}
            </p>
          </div>

          {/* Role selector (register only) */}
          {isRegister && (
            <div className="auth-role-selector">
              {ROLES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  id={`role-${r.id}`}
                  className={`auth-role-btn ${role === r.id ? 'active' : ''}`}
                  onClick={() => setRole(r.id)}
                >
                  <span className="auth-role-icon">{r.icon}</span>
                  <span>{r.label}</span>
                </button>
              ))}
            </div>
          )}

          {/* Form */}
          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            {isRegister && (
              <div className="form-group">
                <label className="form-label" htmlFor="name">Full Name</label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  className={`form-input ${error && !form.name ? 'error' : ''}`}
                  placeholder="Alex Johnson"
                  value={form.name}
                  onChange={handleChange}
                  autoComplete="name"
                  required
                />
              </div>
            )}

            <div className="form-group">
              <label className="form-label" htmlFor="email">Email address</label>
              <input
                id="email"
                name="email"
                type="email"
                className="form-input"
                placeholder="you@example.com"
                value={form.email}
                onChange={handleChange}
                autoComplete="email"
                required
              />
            </div>

            <div className="form-group">
              <div className="flex justify-between items-center">
                <label className="form-label" htmlFor="password">Password</label>
                {!isRegister && (
                  <span className="text-xs text-secondary" style={{ cursor: 'default' }}>
                    {/* Forgot password — M10 stretch */}
                  </span>
                )}
              </div>
              <input
                id="password"
                name="password"
                type="password"
                className="form-input"
                placeholder={isRegister ? 'At least 8 characters' : '••••••••'}
                value={form.password}
                onChange={handleChange}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                required
              />
            </div>

            {/* Error */}
            {error && (
              <div className="auth-error" role="alert">
                <span className="auth-error-icon">⚠</span>
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              id="auth-submit"
              type="submit"
              className="btn btn-primary btn-lg w-full"
              disabled={loading}
            >
              {loading ? (
                <>
                  <div className="spinner" />
                  {isRegister ? 'Creating account…' : 'Signing in…'}
                </>
              ) : (
                isRegister ? 'Create Account' : 'Sign In'
              )}
            </button>
          </form>

          {/* Switch mode */}
          <div className="auth-switch">
            <span className="text-secondary text-sm">
              {isRegister ? 'Already have an account?' : "Don't have an account?"}
            </span>
            <button
              id="auth-mode-toggle"
              type="button"
              className="auth-switch-btn"
              onClick={switchMode}
            >
              {isRegister ? 'Sign in' : 'Create account'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
