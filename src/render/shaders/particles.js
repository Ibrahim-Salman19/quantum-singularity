/**
 * Particle field shaders (GLSL ES 1.00 syntax; Three.js ShaderMaterial).
 *
 * There is no position attribute: the vertex shader derives every particle's
 * position procedurally from its shuffled index, a per-particle seed and the live
 * uniforms (topology morph, gravity, jets, chaos, attractor, audio), so the CPU
 * uploads nothing per frame.
 *
 * @module render/shaders/particles
 */

export const PARTICLE_VERTEX_SHADER = /* glsl */`
    precision highp float;
    #define PI  3.14159265358979
    #define TAU 6.28318530717959
    // Golden angle in radians (137.50776 degrees) -- the phyllotaxis constant.
    #define GOLDEN_ANGLE 2.39996322972865332

    uniform float uTime, uShape, uScale, uGravity, uJetPower, uChaos, uSpeed;
    uniform int   uPalette, uPaletteNext;
    uniform float uPaletteMix, uPSize, uPixel, uTotalCount, uHandInfl, uViewportHeight;
    uniform vec3  uHandPos;
    // Live microphone bands (0..1, smoothed on the CPU) -- a third input channel
    // alongside pointer/hand attraction. Bass swells the whole field radially,
    // treble sharpens curl turbulence, mid drives a hue shift, and pulse is a
    // fast-decaying transient impulse fired on detected onsets.
    uniform float uAudioBass, uAudioTreble, uAudioMid, uAudioPulse;

    attribute float aIndex, aSeed, aPolarity;
    varying vec3  vColor;
    varying float vEnergy, vTwinkle;

    vec3 curl(vec3 p, float t, float f) {
        return vec3(
            cos(p.y*f + t*.7)*sin(p.z*f*1.1) - sin(p.y*f*.9)*cos(p.z*f + t*.5),
            cos(p.z*f + t*.6)*sin(p.x*f*1.2) - sin(p.z*f*.8)*cos(p.x*f + t*.6),
            cos(p.x*f + t*.8)*sin(p.y*f)     - sin(p.x*f*1.1)*cos(p.y*f + t*.7)
        );
    }

    vec4 topo0(float nI, float t, float scl, float grv, float jp, float ch) {
        float isJet = pow(abs(sin(nI * PI * 50.0)), 30.0);
        float dW    = 1.0 - isJet;
        float dR    = scl * (1.2 + 8.0 * pow(nI, 1.5));
        float dTh   = nI * uTotalCount * GOLDEN_ANGLE + t * grv * scl / max(dR, 0.1);
        float dN    = sin(dR * 0.5 - t * 3.0) * ch;
        float dX    = dR * cos(dTh + dN);
        float dZ    = dR * sin(dTh + dN);
        float dY    = sin(dTh * 5.0 + t) * (dR * 0.05) * ch;
        float jY    = aPolarity * (scl + nI * scl * 12.0 * jp);
        float jR    = scl * 0.15 / (1.0 + nI * 10.0) * abs(sin(nI * 100.0 - t * 10.0));
        float jT    = nI * 500.0 + t * 5.0;
        return vec4(dX*dW + jR*cos(jT)*isJet, dY*dW + jY*isJet, dZ*dW + jR*sin(jT)*isJet, isJet);
    }

    vec3 topo1(float nI, float t, float scl, float ch) {
        float phi  = acos(clamp(1.0 - 2.0*nI, -1.0, 1.0));
        float theta = nI * uTotalCount * GOLDEN_ANGLE;
        float m   = 7.0;
        float b1  = abs(cos(m * theta * 0.25));
        float b2  = abs(sin(m * theta * 0.25));
        float rs  = min(8.0, pow(max(1e-6, pow(b1,1.5) + pow(b2,1.5)), -1.0/1.2));
        float fold = phi * (0.6 + 0.4 * cos(t * 0.6));
        float rV  = scl * 0.9 * rs * sin(fold) + sin(nI * 31415.9) * ch * scl * 0.15;
        float zV  = scl * 0.9 * rs * cos(fold) + cos(nI * 27182.8) * ch * scl * 0.15;
        float fTh = theta + sin(rV * 0.05 - t) * 2.0;
        return vec3(rV*cos(fTh), zV, rV*sin(fTh));
    }

    vec3 topo2(float nI, float t, float scl, float ch) {
        float breath = 1.0 + 0.35 * sin(t*1.5 + nI*PI*4.0);
        float gS = floor(nI * 16.0), sub = fract(nI * 16.0);
        float ang = sub * TAU, bS = scl * 0.4 * breath;
        float s1 = mod(gS,2.0)>=1.0?1.:-1., s2=mod(floor(gS/2.),2.)>=1.?1.:-1.;
        float s4 = mod(floor(gS/4.),2.)>=1.?1.:-1., s8=mod(floor(gS/8.),2.)>=1.?1.:-1.;
        float x4=s1*bS+bS*.4*cos(ang*3.+t), y4=s2*bS+bS*.4*sin(ang*2.+t*.7);
        float z4=s4*bS+bS*.4*cos(ang*5.-t*.5), w4=s8*bS+bS*.5*sin(ang*4.+t*1.3)*ch;
        float cx=cos(t*.8), sx=sin(t*.8), tmp=x4*cx-w4*sx; w4=x4*sx+w4*cx; x4=tmp;
        float cy=cos(t*.5), sy=sin(t*.5);      tmp=y4*cy-w4*sy; w4=y4*sy+w4*cy; y4=tmp;
        float f=(scl*2.0)/max(0.001, 2.5*scl+w4);
        return vec3(x4*f, y4*f, z4*f);
    }

    vec3 topo3(float nI, float t, float scl, float ch) {
        float tC=nI*PI*64.+t*.2, pC=nI*TAU+t*.5;
        float rC=scl*(.4+.6*sin(nI*100.+t));
        float wA=sin(tC*.5+t)*ch, wB=cos(pC*3.-t*.7)*ch;
        return vec3(rC*sin(tC)*cos(pC+wA)+cos(tC*7.)*(ch*4.),
                    rC*sin(tC)*sin(pC+wB)+sin(pC*7.)*(ch*4.),
                    rC*cos(tC)+sin(tC*11.+t*2.)*(ch*3.));
    }

    // topo4: Hopf Fibration — stereographic projection of S³ onto R³.
    // Each particle traces one fibre of the Hopf bundle π: S³ → S². The fibre
    // through the point (η,ξ) on S² is a great circle on S³; stereographic
    // projection maps it to a circle in R³. Nearby fibres on S² produce linked
    // circles in R³ that never intersect — the global result is a nested toroidal
    // weave filling all of space. The slowly-breathing η parameter makes the
    // whole structure pulse gently rather than standing rigid.
    vec3 topo4(float nI, float t, float scl, float ch) {
        // u parametrizes position along the fibre circle; v shifts fibres within
        // the chosen latitude band; eta selects which latitude on S².
        float u   = nI * TAU * 17.0 + t * 0.38;
        float v   = nI * PI  * 9.0  + t * 0.21;
        float eta = PI * (0.22 + 0.18 * sin(t * 0.41 + nI * TAU * 3.0));
        // Unit quaternion on S³ (cos(η)·e^{iu}, sin(η)·e^{iv}):
        float q1 = cos(eta) * cos(u);
        float q2 = cos(eta) * sin(u);
        float q3 = sin(eta) * cos(v);
        float q4 = sin(eta) * sin(v);
        // Inverse stereographic projection from south pole (q4 = −1). The
        // denominator is clamped away from zero so the south-pole singularity
        // cannot produce Inf/NaN for the ~0.1% of particles that land there.
        float denom = max(0.08, 1.0 + q4);
        vec3 p = vec3(q1, q2, q3) / denom * (scl * 0.44);
        // Mild curl displacement so the fibres visibly breathe:
        p += curl(p, t, 0.022) * (ch * scl * 0.09);
        return p;
    }

    // topo5: Lorenz manifold surface — closed-form butterfly parametrization.
    // A live Lorenz integrator (σ=10, ρ=28, β=8/3) would need ~1000 RK4 steps
    // per particle per frame — GPU-impossible in a vertex shader. Instead we
    // parametrize the two Lorenz wings as ruled spiral surfaces whose shape
    // matches the qualitative butterfly geometry: each wing is a rolled spiral
    // in (r,ψ) that collapses onto its fixed-point locus, and the two wings are
    // mirror-reflected across the symmetry axis (x ↔ −x, z unchanged).
    vec3 topo5(float nI, float t, float scl, float ch) {
        float side  = nI < 0.5 ? -1.0 : 1.0;          // left / right wing
        float local = abs(nI * 2.0 - 1.0);             // 0..1 within each wing
        // Radial growth along the spiral arm: slow power curve matches the
        // Lorenz attractor's denser inner and sparser outer orbits.
        float r   = scl * (0.28 + 1.15 * pow(local, 0.72));
        // Spiral angle: 3.2 full turns per wing, slowly precessing with time
        // so it never stands still, plus a chaos-driven wobble.
        float psi = local * TAU * 3.2 + t * (0.18 + 0.07 * ch);
        // Characteristic tilt of the Lorenz wings: ≈ atan(√(ρ−1)/σ) ≈ 0.51 rad,
        // slowly rocking so the lobes appear to breathe around the saddle.
        float tilt = 0.51 + 0.12 * sin(t * 0.35);
        float x  = side * r * cos(psi);
        float y  = r * sin(psi) * cos(tilt) + scl * (0.50 * local);
        float z  = r * sin(psi) * sin(tilt);
        vec3  p  = vec3(x, y - scl * 0.25, z);
        p += curl(p, t, 0.019) * (ch * scl * 0.07);
        return p;
    }

    vec3 hsl2rgb(vec3 c) {
        vec3 rgb = clamp(abs(mod(c.x*6.+vec3(0.,4.,2.),6.)-3.)-1.,0.,1.);
        return c.z + c.y*(rgb-.5)*(1.-abs(2.*c.z-1.));
    }

    vec3 colorize(int pal, float nd, float nI, float t, float isJet, float dW) {
        float h;
        if      (pal==0) h=(0.52+nd*.35-t*.08)*dW + (0.08+nI*.12-t*.3)*isJet;
        else if (pal==1) h=(0.96+nd*.18-t*.08)*dW + (0.12+nI*.18-t*.3)*isJet;
        else if (pal==2) h=(0.80+nd*.30-t*.08)*dW + (0.48+nI*.20-t*.3)*isJet;
        else if (pal==3) h=(0.33+nd*.38-t*.07)*dW + (0.68+nI*.25-t*.4)*isJet;
        else             h=(0.05+nd*.80-t*.10)*dW + (0.60+nI*.20-t*.5)*isJet;
        return hsl2rgb(vec3(fract(h+10.),
                            0.92 + 0.08*sin(nI*1000.),
                            clamp((1.-nd)*dW + isJet*.92, 0.18, 0.92)));
    }

    void main() {
        float nI  = aIndex;
        float t   = uTime * uSpeed * 0.85;
        float sf  = clamp(uShape, 0.0, 5.0);
        float sfF = floor(sf), sfFrac = sf - sfF;

        vec3 p0 = vec3(0.0), p1 = vec3(0.0);
        float isJet = 0.0, dW = 1.0;

        if (sfF < 1.0) {
            vec4 r = topo0(nI, t, uScale, uGravity, uJetPower, uChaos);
            p0 = r.xyz; isJet = r.w; dW = 1.0 - isJet;
            if (sfFrac > 0.0002) p1 = topo1(nI, t, uScale, uChaos);
        } else if (sfF < 2.0) {
            p0 = topo1(nI, t, uScale, uChaos);
            if (sfFrac > 0.0002) p1 = topo2(nI, t, uScale, uChaos);
        } else if (sfF < 3.0) {
            p0 = topo2(nI, t, uScale, uChaos);
            if (sfFrac > 0.0002) p1 = topo3(nI, t, uScale, uChaos);
        } else if (sfF < 4.0) {
            p0 = topo3(nI, t, uScale, uChaos);
            if (sfFrac > 0.0002) p1 = topo4(nI, t, uScale, uChaos);
        } else if (sfF < 5.0) {
            p0 = topo4(nI, t, uScale, uChaos);
            if (sfFrac > 0.0002) p1 = topo5(nI, t, uScale, uChaos);
        } else {
            p0 = topo5(nI, t, uScale, uChaos);
        }

        vec3 pos = mix(p0, p1, sfFrac);

        pos += curl(pos, t, 0.018) * (uChaos * uScale * 0.04) * (1.0 + uAudioTreble * 0.8);
        pos *= 1.0 + uAudioBass * 0.05 + uAudioPulse * 0.025;

        const float TILT = 0.47124;
        float ct = cos(TILT), st = sin(TILT);
        vec3 rp = vec3(pos.x, pos.y*ct - pos.z*st, pos.y*st + pos.z*ct);
        float sp = t * 0.2, csp = cos(sp), ssp = sin(sp);
        vec3 wp = vec3(rp.x*csp - rp.z*ssp, rp.y, rp.x*ssp + rp.z*csp);

        if (uHandInfl > 0.005) {
            vec3 dv  = wp - uHandPos;
            float dl = length(dv);
            float f  = uHandInfl * uScale * 2.2 / (dl * dl + uScale + 0.001);
            wp -= (dv / max(dl, 0.001)) * f * 0.35;
        }

        float dist = length(wp);
        float nd   = dist / (uScale * 8.0 + 0.001);
        // Palette cross-fade only runs during the ~420ms swatch transition. Guarding
        // it avoids evaluating a second full colorize() (a 5-way branch plus hsl2rgb)
        // for every one of up to 110k vertices on every steady-state frame.
        vColor = colorize(uPalette, nd, nI, t, isJet, dW);
        if (uPaletteMix > 0.001) {
            vColor = mix(vColor, colorize(uPaletteNext, nd, nI, t, isJet, dW), uPaletteMix);
        }
        // Mid-band (250–2000 Hz) hue shift: a perceptual luma-preserving rotation
        // in hue space. dot(vColor, luma) converts to approximate perceptual
        // luminance; fract keeps the hue angle in [0,1]. This runs only when audio
        // mid is active, so steady-state (audio off) has zero extra ALU cost.
        if (uAudioMid > 0.01) {
            float luma = dot(vColor, vec3(0.299, 0.587, 0.114));
            float sat  = clamp(luma * 1.85, 0.18, 0.92);
            vColor = hsl2rgb(vec3(fract(luma + uAudioMid * 0.14 + 10.0), sat, sat));
        }
        vEnergy = 0.8 + isJet * 2.2 + (1.0 - clamp(nd,0.,1.)) * 1.3 + uAudioPulse * 1.6 + uAudioTreble * 0.4;
        vTwinkle= 0.78 + 0.22 * sin(uTime * (2.5 + aSeed * 4.5) + aSeed * 62.83);

        vec4 mv = modelViewMatrix * vec4(wp, 1.0);
        // projectionMatrix[1][1] == 1/tan(fov/2); combined with viewport height this
        // gives a physically correct perspective size that tracks FOV and window size.
        float psScale = projectionMatrix[1][1] * uViewportHeight * 0.32;
        gl_PointSize = clamp(vEnergy * uPSize * (psScale / max(-mv.z, 1.0)), 0.6 * uPixel, 42.0 * uPixel);
        gl_Position  = projectionMatrix * mv;
    }
`;

export const PARTICLE_FRAGMENT_SHADER = /* glsl */`
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying vec3  vColor;
    varying float vEnergy, vTwinkle;

    void main() {
        vec2  coord = gl_PointCoord - 0.5;
        float d     = length(coord);
        // No discard, no conditional branch: beyond d = 0.5 all three falloffs are
        // already zero, so the additive blend contributes nothing and the write is
        // a no-op. discard (or an explicit early-out if) would disable Early-Z and
        // framebuffer compression on tile-based mobile GPUs -- the only thing worse
        // than a zero write is preventing the hardware from skipping it.
        float core  = 1.0 - smoothstep(0.0, 0.14, d);
        float inner = 1.0 - smoothstep(0.0, 0.28, d);
        float halo  = 1.0 - smoothstep(0.0, 0.50, d);

        vec3 col = vColor * (core * (1.0 + vEnergy * 1.4) * 2.2 + inner * 1.1 + halo * 0.4);
        col += vec3(-0.04, -0.01, 0.07) * core * 0.35;

        float alpha = (core * 0.95 + inner * 0.55 + halo * 0.3) * vTwinkle;
        gl_FragColor = vec4(col, alpha);
    }
`;
