/**
 * Final-look post-processing pass (GLSL ES 3.00): radial chromatic aberration,
 * aspect-correct vignette and film grain from an integer PCG hash. Runs after
 * bloom, before Three.js's OutputPass tone-maps to the display.
 *
 * @module render/shaders/cinematic
 */

export const CINEMATIC_VERTEX_SHADER = /* glsl */`
        out vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
`;

export const CINEMATIC_FRAGMENT_SHADER = /* glsl */`
        #ifdef GL_FRAGMENT_PRECISION_HIGH
        precision highp float;
        precision highp int;
        #else
        precision mediump float;
        precision mediump int;
        #endif
        // GLSL ES 3.0 output variable (gl_FragColor is removed in GLSL3).
        out vec4 fragColor;
        uniform sampler2D tDiffuse;
        uniform float uTime, uCA, uVig, uGrain;
        uniform vec2 uAspect;
        in vec2 vUv;
        void main() {
            // Work in an aspect-corrected space so "distance from centre" is a real
            // radial distance rather than a UV-space ellipse.
            vec2 c = (vUv - 0.5) * uAspect;
            float d = length(c);

            vec3 col;
            // Chromatic aberration costs three dependent texture fetches. When the
            // effect is dialled down (reduced-motion / low quality) it is invisible,
            // so skip straight to a single fetch and save the bandwidth.
            if (uCA > 0.0002) {
                vec2 dir = d > 0.001 ? (c / d) * (uCA * d * d * 4.0) / uAspect : vec2(0.0);
                col = vec3(
                    texture(tDiffuse, vUv + dir).r,
                    texture(tDiffuse, vUv).g,
                    texture(tDiffuse, vUv - dir).b
                );
            } else {
                col = texture(tDiffuse, vUv).rgb;
            }

            // Vignette. Previously smoothstep(0.28, 0.82, d * 0.52) which, given d
            // maxes at ~0.707, peaked at ~6% darkening in the corners and never
            // touched the centre. Now calibrated across the actual radial range.
            float vig = 1.0 - uVig * smoothstep(0.42, 1.05, d);
            col *= vig;

            // Grain is applied to a perceptual (roughly gamma-encoded) value rather
            // than the linear HDR value. Adding a linear +/-0.018 offset near black
            // becomes +/-0.15 after the sRGB encode in OutputPass -- coarse, blocky
            // shadow noise. Encoding first keeps the grain perceptually uniform.
            // PCG-style integer hash: avoids the sin()*43758 transcendental which
            // hits every pixel every frame at full resolution. floatBitsToUint is
            // pure bitwise arithmetic -- same perceptual quality, lower ALU cost.
            if (uGrain > 0.001) {
                uvec2 q = uvec2(gl_FragCoord.xy) ^ uvec2(floatBitsToUint(uTime * 0.71));
                q.x ^= q.y * 1664525u + 1013904223u;
                q.x ^= q.x >> 16u;
                q.x *= 0x45d9f3bu;
                q.x ^= q.x >> 16u;
                float noise = (float(q.x & 0xffffffu) / float(0xffffffu)) - 0.5;
                vec3 enc = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
                enc += noise * uGrain;
                col = pow(max(enc, vec3(0.0)), vec3(2.2));
            }

            fragColor = vec4(col, 1.0);
        }
`;
