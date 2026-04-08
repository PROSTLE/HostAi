(() => {
  const MAX_RIPPLES = 8;

  class LiquidGlassBackground {
    constructor(container) {
      this.container = container;
      this.enabled = !!(window.THREE && container);
      this.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.ripples = Array.from({ length: MAX_RIPPLES }, () => ({ x: 0.5, y: 0.5, age: 99, strength: 0 }));
      this.lastPointer = { x: 0.5, y: 0.5, t: performance.now() };
      this.running = false;
      this.rafId = null;

      this.onPointerMove = this.onPointerMove.bind(this);
      this.onVisibility = this.onVisibility.bind(this);
      this.onResize = this.onResize.bind(this);
      this.animate = this.animate.bind(this);
    }

    init() {
      if (!this.enabled || this.prefersReducedMotion) return;
      const THREE = window.THREE;

      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.domElement.style.opacity = '0.9';
      this.container.appendChild(this.renderer.domElement);

      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      this.uniforms = {
        u_time: { value: 0 },
        u_resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        u_ripples: { value: this.ripples.map((r) => new THREE.Vector4(r.x, r.y, r.age, r.strength)) },
      };

      this.material = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: `
          precision highp float;
          varying vec2 vUv;

          uniform float u_time;
          uniform vec2 u_resolution;
          uniform vec4 u_ripples[${MAX_RIPPLES}];

          vec3 baseGradient(vec2 uv) {
            vec3 c1 = vec3(0.91, 0.95, 0.99);
            vec3 c2 = vec3(0.83, 0.90, 0.98);
            vec3 c3 = vec3(0.89, 0.86, 0.98);
            vec3 g = mix(c1, c2, smoothstep(0.0, 1.0, uv.y));
            g = mix(g, c3, smoothstep(0.15, 0.9, uv.x * 0.65 + uv.y * 0.35));
            return g;
          }

          vec3 frostedSample(vec2 uv) {
            vec2 px = vec2(1.0) / max(u_resolution, vec2(1.0));
            vec3 c = vec3(0.0);
            c += baseGradient(uv);
            c += baseGradient(uv + vec2(1.6 * px.x, 0.0));
            c += baseGradient(uv + vec2(-1.6 * px.x, 0.0));
            c += baseGradient(uv + vec2(0.0, 1.6 * px.y));
            c += baseGradient(uv + vec2(0.0, -1.6 * px.y));
            return c / 5.0;
          }

          void main() {
            vec2 uv = vUv;
            vec2 disp = vec2(0.0);
            float highlight = 0.0;

            for (int i = 0; i < ${MAX_RIPPLES}; i++) {
              vec4 rp = u_ripples[i];
              float age = rp.z;
              float strength = rp.w;

              vec2 d = uv - rp.xy;
              float dist = length(d) + 0.0001;
              float ring = sin(dist * 62.0 - age * 8.0);
              float envelope = exp(-dist * 9.0) * exp(-age * 1.6) * strength;
              float wave = ring * envelope;

              disp += normalize(d) * wave * 0.018;
              highlight += max(0.0, wave) * 1.25;
            }

            vec2 refrUv = clamp(uv + disp, 0.0, 1.0);
            vec3 col = frostedSample(refrUv);

            col += vec3(0.025, 0.03, 0.05) * highlight;
            col += vec3(0.01, 0.014, 0.02) * sin((uv.x + uv.y + u_time * 0.02) * 10.0);

            gl_FragColor = vec4(col, 1.0);
          }
        `,
      });

      const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
      this.scene.add(plane);

      window.addEventListener('pointermove', this.onPointerMove, { passive: true });
      window.addEventListener('resize', this.onResize, { passive: true });
      document.addEventListener('visibilitychange', this.onVisibility, { passive: true });

      this.running = true;
      this.rafId = requestAnimationFrame(this.animate);
    }

    onPointerMove(event) {
      const x = event.clientX / Math.max(1, window.innerWidth);
      const y = 1 - event.clientY / Math.max(1, window.innerHeight);
      const now = performance.now();

      const dx = x - this.lastPointer.x;
      const dy = y - this.lastPointer.y;
      const dt = Math.max(16, now - this.lastPointer.t);
      const speed = Math.min(1, Math.sqrt(dx * dx + dy * dy) / (dt * 0.02));
      const strength = Math.min(0.85, 0.18 + speed * 0.5);

      this.addRipple(x, y, strength);

      this.lastPointer.x = x;
      this.lastPointer.y = y;
      this.lastPointer.t = now;
    }

    addRipple(x, y, strength) {
      let targetIndex = 0;
      let oldestAge = -1;

      for (let i = 0; i < this.ripples.length; i++) {
        if (this.ripples[i].strength <= 0.001) {
          targetIndex = i;
          oldestAge = Number.POSITIVE_INFINITY;
          break;
        }
        if (this.ripples[i].age > oldestAge) {
          oldestAge = this.ripples[i].age;
          targetIndex = i;
        }
      }

      this.ripples[targetIndex] = { x, y, age: 0, strength };
    }

    animate(t) {
      if (!this.running) return;

      this.uniforms.u_time.value = t * 0.001;

      for (let i = 0; i < this.ripples.length; i++) {
        const rp = this.ripples[i];
        rp.age += 0.016;
        rp.strength *= 0.985;
        if (rp.age > 3.4 || rp.strength < 0.002) {
          rp.strength = 0;
        }

        this.uniforms.u_ripples.value[i].set(rp.x, rp.y, rp.age, rp.strength);
      }

      this.renderer.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(this.animate);
    }

    onResize() {
      if (!this.renderer || !this.uniforms) return;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.uniforms.u_resolution.value.set(window.innerWidth, window.innerHeight);
    }

    onVisibility() {
      if (document.hidden) {
        this.running = false;
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = null;
        return;
      }

      if (!this.running) {
        this.running = true;
        this.rafId = requestAnimationFrame(this.animate);
      }
    }
  }

  function initLiquidGlassBackground() {
    const container = document.getElementById('liquid-glass-bg');
    if (!container) return null;

    const effect = new LiquidGlassBackground(container);
    effect.init();
    return effect;
  }

  window.initLiquidGlassBackground = initLiquidGlassBackground;
})();
