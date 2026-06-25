class ShaderGeneratorEffects {
    static MAX_VARIATIONS_PER_EFFECT = 10;

    static getAvailableEffects() {
        return [
            {
                id: 'spectrum',
                name: 'Spectrum Analyzer',
                description: 'Audio texture visualization (EQ, Waveforms)',
                code: this.getSpectrumVariations(),
                variantNames: this.getSpectrumVariantNames,
                // Includes u_spectrum plus full audio suite
                uniforms: ['u_spectrum', 'u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'biomath',
                name: 'Bio-Digital (Xor)', 
                description: 'Complex raymarched structures inspired by Code Golf shaders',
                code: this.getBioMathVariations(),
                variantNames: this.getBioMathVariantNames,
                uniforms: ['u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'modifier',
                name: 'Space Distortion', 
                description: 'Distorts the coordinate space without drawing color directly',
                code: this.getModifierVariations(),
                variantNames: this.getModifierVariantNames,
                uniforms: ['u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'plasma',
                name: 'Plasma Waves',
                description: 'Flowing plasma-like patterns',
                code: this.getPlasmaVariations(),
                variantNames: this.getPlasmaVariantNames,
                uniforms: ['u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'fractal',
                name: 'Fractal Patterns',
                description: 'Recursive geometry (Mandelbrot, KIFS, Julia)',
                code: this.getFractalVariations(),
                variantNames: this.getFractalVariantNames,
                uniforms: ['u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'tunnel',
                name: 'Tunnel Effect',
                description: 'Perspective depth (Cylindrical, Box, Warp)',
                code: this.getTunnelVariations(),
                variantNames: this.getTunnelVariantNames,
                uniforms: ['u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'particles',
                name: 'Particle System',
                description: 'Dynamic particle effects',
                code: this.getParticleVariations(),
                variantNames: this.getParticleVariantNames,
                uniforms: ['u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'waves',
                name: 'Wave Patterns',
                description: 'Complex wave interference',
                code: this.getWaveVariations(),
                variantNames: this.getWaveVariantNames,
                uniforms: ['u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'geometry',
                name: 'Geometric Shapes',
                description: 'Sacred geometry, Grids, and Tiles',
                code: this.getGeometricVariations(),
                variantNames: this.getGeometricVariantNames,
                uniforms: ['u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'fluid',
                name: 'Fluid Dynamics',
                description: 'Liquid simulation and Oil slicks',
                code: this.getFluidVariations(),
                variantNames: this.getFluidVariantNames,
                uniforms: ['u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'lightning',
                name: 'Lightning & Electric',
                description: 'Electrical discharge and lightning bolts',
                code: this.getLightningVariations(),
                variantNames: this.getLightningVariantNames,
                uniforms: ['u_spectrum', 'u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'crystal',
                name: 'Crystal Structures',
                description: 'Crystalline, Faceted, and Shattered patterns',
                code: this.getCrystalVariations(),
                variantNames: this.getCrystalVariantNames,
                uniforms: ['u_time', 'u_bass', 'u_mid', 'u_treble']
            },
            {
                id: 'galaxy',
                name: 'Cosmic Space',
                description: 'Spirals, Black Holes, and Nebulas',
                code: this.getGalaxyVariations(),
                variantNames: this.getGalaxyVariantNames,
                uniforms: ['u_time', 'u_bass', 'u_mid', 'u_treble']
            }
        ];
    }

    static getHelperFunctions() {
        return `
        float random(vec2 st) {
            return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
        }

        float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(random(i + vec2(0.0,0.0)), 
                          random(i + vec2(1.0,0.0)), u.x),
                      mix(random(i + vec2(0.0,1.0)), 
                          random(i + vec2(1.0,1.0)), u.x), u.y);
        }

        vec2 rotate(vec2 p, float angle) {
            float c = cos(angle);
            float s = sin(angle);
            return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
        }

        // Frequency texture sampler helper
        float getFreq(float f) {
            // Clamp to avoid texture edge artifacts
            float freq = clamp(f, 0.01, 0.99);
            float freqValue = texture(u_spectrum, vec2(freq, 0.0)).r;
            
            // Fallback: create demo pattern when no audio (spectrum is all zeros)
            // This creates a gentle wave pattern so effects are visible in preview
            float demo = 0.3 + 0.2 * sin(freq * 10.0 + u_time * 2.0) 
                             + 0.15 * sin(freq * 25.0 + u_time * 3.0);
            
            // Mix between real audio and demo based on audio level
            float audioLevel = freqValue;
            return mix(demo, freqValue, step(0.01, audioLevel));
        }
        `;
    }

    /* --- BIOMATH (XOR) --- */
    static getBioMathVariations() {
        const variations = [
            // 1. Xor Neural
            `
            vec3 rayDir = normalize(vec3(uv, -1.0));
            vec3 p = vec3(0.0);
            vec3 col = vec3(0.0);
            float z = 0.0;
            float speed = 2.0 + u_bass * 4.0;
            
            for(int i=0; i<30; i++) {
                p = z * rayDir;
                p.z -= u_time * speed;
                float shape = cos(dot(cos(p), sin(p.yzx / 0.6 + 0.1 * sin(p.zxy * 10.0)) * 10.0));
                float d = 0.01 + 0.3 * abs(shape);
                // Safe usage
                float brightness = 1.0;
                #ifdef u_intensity
                    brightness = u_intensity;
                #endif
                vec3 glow = vec3(0.2, 0.2, 0.3) * brightness + palette(z * 0.05 + u_time) * 0.1;
                col += glow / max(0.001, d); 
                z += d;
            }
            vec3 layerColor = tanh(col * 0.002);
            `,
            // 2. Gyroid Lattice
            `
            vec3 rd = normalize(vec3(uv, 1.0));
            vec3 p = vec3(0.0);
            float t = 0.0;
            vec3 acc = vec3(0.0);
            for(int i=0; i<32; i++) {
                p = rd * t;
                p.z += u_time + u_bass; 
                p.xy = rotate(p.xy, u_time * 0.2);
                float d = dot(sin(p), cos(p.yzx)) / 1.5;
                d = abs(d) - 0.1;
                if(d < 0.01) {
                    acc += palette(t * 0.1 + u_mid) * 0.1;
                }
                t += max(0.05, d * 0.5);
            }
            float intens = 1.0;
            #ifdef u_intensity
                intens = u_intensity;
            #endif
            vec3 layerColor = acc * intens;
            `,
            // 3. Crystalline Lattice (Xor)
            `
            // Scale the UV coordinates (equivalent to uv / 0.3)
            vec2 p = uv * 3.3333;
            vec3 col = vec3(0.0);
            
            // Audio reactive time 
            float t = u_time * 1.2 + u_bass * 1.5;

            // Outer accumulation loop (1e1 = 10 iterations)
            for(float i = 1.0; i <= 10.0; i++) {
                vec2 v = p;
                
                // Inner turbulence loop (fBm-style space folding)
                for(float f = 1.0; f <= 9.0; f++) {
                    // Swizzle v.yx to swap coordinates, creating the weaving liquid effect
                    v += sin(v.yx * f + i + t) / f;
                }
                
                // Color palette (converted from golfed vec4 to vec3)
                vec3 pal = cos(i + vec3(0.0, 1.0, 2.0)) + 1.0;
                
                // SAFE: Prevent divide-by-zero if length(v) hits exactly 0.0
                // Original math was: pal / 6.0 / length(v)
                col += pal / (6.0 * max(0.001, length(v)));
            }
            
            float intens = 1.0;
            #ifdef u_intensity
                intens = u_intensity;
            #endif
            
            // Original output squashed the squared colors: tanh(o*o)
            // We pad it with u_intensity and u_mid so the bright web pulses to the beat
            vec3 layerColor = tanh((col * col) * intens * (1.0 + u_mid * 0.3));
            `,
            // 4. Hypnotic Spiral (Xor)
            `
            vec2 p = uv * 2.0;
            // SAFE: Added 1e-6 to length(p) to prevent log(0) which is -Infinity
            vec2 v = vec2(atan(p.y, p.x), log(length(p) + 1e-6)) / 0.2 + 4.0;
            
            vec4 col = vec4(0.0);
            float t = u_time + u_bass; 

            for(float i=1.0; i<9.0; i++) {
                v += sin(v.yx * i - vec2(t, i)) / i;
                col += (sin(vec4(v.x, v.x, v.y, v.x) + i) + 1.0) * (v.y * v.y);
            }
            // SAFE: Add epsilon to avoid divide by zero if col is black
            vec3 layerColor = tanh(vec3(4.0, 2.0, 1.0) / (col.rgb + 0.001));
            `,
            // 5. Alien Terrain (Xor)
            `
            vec3 rayDir = normalize(vec3(uv, -1.0));
            vec3 p = vec3(0.0);
            vec3 v = vec3(0.0);
            vec3 col = vec3(0.0);
            float z = 0.0;
            float d = 0.0;
            float t = u_time * 2.0 + u_bass * 4.0;

            for(float i=0.0; i<50.0; i++) {
                p = z * rayDir;
                p.xz -= t;
                v = p - vec3(sin(p.x), sin(p.x), sin(p.z));
                float dotProd = dot(cos(v.xz), sin(v.zx / 0.6));
                d = 0.4 * max(dotProd + 0.6, v.y + 3.0);
                
                vec3 fog = -rayDir * d * d / (z * z + 1.0);
                vec3 pal = cos(p.y + vec3(6.0, 1.0, 2.0)) + 1.1;
                vec2 trig = tan(p.y / 0.3) / (cos(p.xz / 0.1) + 0.1 + (2.0* u_mid));
                float lightStruct = length(trig) + d * d / 0.01;
                
                // SAFE: Ensure denominator is never zero
                vec3 light = pal / (lightStruct + 0.01) / (z + 0.1 / (u_bass + 0.01));

                col += (fog * u_treble) + (light * u_mid);
                z += max(0.02, d); 
            }
            vec3 layerColor = tanh(col * 0.1);
            `,
            // 6. Xor Digital Sphere
            `
            
            vec3 o = vec3(0.0);
            vec3 p = vec3(0.0);
            vec3 v = vec3(0.0);
            
            float z_pos = 0.0;
            float d = 0.0;
            float l = 0.0;
            float t = u_time * 0.5;
            
            // Create 3D fragment coordinates (Shadertoy-style FC.rgb)
            vec3 FC = vec3(gl_FragCoord.xy, 0.0);
            vec3 r = vec3(u_resolution.xy, u_resolution.x);
            
            // Raymarching loop (80 iterations)
            for(float i = 0.0; i < 80.0; i++) {
                // p=z*normalize(FC.rgb*2.-r.xyy)
                p = z_pos * normalize(FC * 2.0 - r.xyy);
                
                // p.z+=9.
                p.z += 9.0;
                
                // p=vec3(atan(p.z,p.x)-t*.1,log(l=length(p))-t*.2,asin(p.y/l))/.1
                l = length(p);
                p = vec3(atan(p.z, p.x) - t * 0.2, log(l) - t * 0.2, asin(clamp(p.y / l, -1.0, 1.0))) / 0.1;
                
                // z+=d=l/6e1*length(max(v=cos(p+sin(p/.24+t)),v.yzx*.1))
                v = cos(p + sin(p / 0.24 + t));
                vec3 v_yzx_select = v.yzx * 0.1 + (u_treble  * 0.01);
                d = l / 60.0 * length(max(v, v_yzx_select));
                z_pos += d;
                
                // o+=(sin(p.y+vec4(6,1,3,3))+1.)/d
                // Use .xyz to convert vec4 result to vec3
                o += (sin(vec4(p.y) + vec4(6.0, 1.0, 3.0, 3.0)) + 0.10 + u_bass ).xyz / d;
            }
            
            // o=tanh(o/2e4)
            vec3 layerColor = tanh(o / 20000.0);
            
            // Audio reactivity
            float intens = 1.0;
            #ifdef u_intensity
                intens = u_intensity;
            #endif
            layerColor *= intens * (1.0 + u_bass * 0.5 + u_mid * 0.3);
            `,
            // 7. Orchard (refactored from xor's one-liner)
            `
            
            vec3 o = vec3(0.0);
            vec3 p = vec3(0.0);
            
            float t = u_time * 0.5;
            
            // Create 3D fragment coordinates (Shadertoy-style)
            vec3 FC = vec3(gl_FragCoord.xy, 0.0);
            vec3 r = vec3(u_resolution.xy, u_resolution.x);
            
            // v=normalize(FC.rgb*2.-r.xyx)
            vec3 v = normalize(FC * 2.0 - r.xyx);
            
            // c=v/v.y; c.z+=.5*t
            vec3 c = v / v.y;
            c.z += 0.5 * t;
            
            float z_pos = 0.0;
            float i = 0.0;
            float b = 0.0;
            float g = 0.0;
            float m = 0.0;
            
            // for(float z,i,b,g,m;i++<5e1;...)
            for(i = 0.0; i < 50.0; i++) {
                // z+=.8*max(b=length(...),min(4.-m,g=length(...))-b)
                // First branch: b=length((p.y-m)/1e2/(abs(sin(c.xz/.1))-.05/v.y))
                vec2 sin_c_xz = sin(c.xz / 0.1);
                vec2 abs_sin_c_xz = abs(sin_c_xz);
                vec2 denom1 = abs_sin_c_xz - 0.05 / v.y;
                b = length((p.y - m) / 100.0 / denom1);
                
                // Second branch: g=length(sin(p.xz)+1.-.1*(1.+sin(p.y-p.zx*.5))*m)
                vec2 sin_p_y_p_zx = sin(p.y - p.zx * 0.5);
                vec2 inner_term = vec2(1.0) + sin_p_y_p_zx;
                vec2 g_term = sin(p.xz) + vec2(1.0) - 0.1 * inner_term * m;
                g = length(g_term);
                
                z_pos += 0.8 * max(b, min(4.0 - m, g) - b);
                
                // o.rgb+=(.7-v)/(g+b)
                o.rgb += (vec3(0.7) - v) / (g + b);
                
                // p=z*v+1.,p.z-=t
                p = z_pos * v + 1.0;
                p.z -= t;
                
                // m=abs(++p.y)
                p.y += 1.0;
                m = abs(p.y);
            }
            
            // o=tanh(o/5e2)
            vec3 layerColor = tanh(o / 500.0);
            
            // Audio reactivity
            float intens = 1.0;
            #ifdef u_intensity
                intens = u_intensity;
            #endif
            layerColor *= intens * (1.0 + u_bass * 0.5 + u_mid * 0.3);
            `
            
        ];
        return variations;
    }

    /* --- SPECTRUM ANALYZER --- */
    static getSpectrumVariations() {
        const variations = [
            // 1. Circular EQ
            `
            float dist = length(uv);
            float angle = atan(uv.y, uv.x);
            float fIndex = abs(angle) / 3.14159; 
            float val = getFreq(fIndex);
            float ring = smoothstep(0.01, 0.0, abs(dist - (0.2 + val * 0.5)));
            ring += smoothstep(0.2, 0.0, abs(dist - (0.2 + val * 0.5))) * 0.5 * u_bass;
            vec3 layerColor = palette(fIndex + u_time * 0.2) * ring;
            `,
            // 2. Digital Bars
            `
            float fIndex = abs(uv.x); 
            float val = getFreq(fIndex);
            float barWidth = 0.05;
            float barID = floor(fIndex / barWidth);
            float qVal = getFreq(barID * barWidth + barWidth * 0.5);
            float bar = step(abs(uv.y), qVal * 0.8);
            float grid = step(0.002, abs(mod(uv.x, barWidth) - barWidth * 0.5));
            bar *= grid;
            vec3 layerColor = palette(barID * 0.1 + u_time) * bar;
            layerColor += vec3(0.2, 0.5, 1.0) * bar * u_treble;
            `,
            // 3. Spectrum Terrain
            `
            float val = getFreq(abs(uv.x));
            float wave = sin(uv.x * 20.0 + u_time * 2.0) * 0.1;
            float line = smoothstep(0.01, 0.0, abs(uv.y - (val - 0.5 + wave)));
            float fill = smoothstep(0.0, 0.2, (val - 0.5 + wave) - uv.y);
            vec3 layerColor = palette(uv.x * 2.0 + u_time) * (line + fill * 0.5);
            layerColor += exp(-abs(uv.y) * 2.0) * u_bass * vec3(0.5, 0.2, 1.0);
            `,
            // 4. Waterfall Spectrum
            // Classic scrolling FFT display - frequencies scroll from top to bottom
            `
            vec2 p = uv;
            
            // Create scrolling effect
            float scrollSpeed = 0.5;
            float scrollY = fract(p.y + u_time * scrollSpeed);
            
            // Get frequency based on X position
            float fIndex = abs(p.x);
            float val = getFreq(fIndex);
            
            // Current bar (most recent, at top)
            float barIntensity = smoothstep(0.02, 0.0, abs(scrollY - 0.95)) * val;
            
            // Add fading trail effect
            float trail = 0.0;
            for(float i = 1.0; i < 8.0; i++) {
                float trailY = fract(scrollY - i * 0.12);
                float trailFreq = getFreq(fIndex + i * 0.001); // Slight frequency shift for variation
                trail += smoothstep(0.15, 0.0, abs(trailY - 0.95)) * trailFreq * (1.0 - i * 0.1);
            }
            
            // Color based on frequency position (bass = left, treble = right)
            vec3 layerColor = palette(fIndex + p.y * 0.5) * barIntensity;
            layerColor += palette(fIndex * 0.5 + 0.5) * trail * 0.6;
            
            // Add bass glow
            layerColor += vec3(0.8, 0.2, 0.4) * barIntensity * u_bass * 0.3;
            `,
            // 5. Horizontal Bars
            // Classic horizontal bar graph spectrum analyzer
            `
            vec2 p = uv;
            
            // Divide screen into horizontal bands
            float bandCount = 32.0;
            float bandHeight = 1.0 / bandCount;
            float bandIndex = floor((p.y + 0.5) * bandCount);
            float bandFreq = bandIndex / bandCount;
            
            // Get frequency value for this band
            float val = getFreq(bandFreq);
            
            // Create horizontal bar
            float bar = step(p.x + 0.5, val);
            
            // Add gradient along the bar
            float barGradient = smoothstep(0.0, 0.3, p.x + 0.5);
            bar *= barGradient;
            
            // Color based on frequency (bass = bottom, treble = top)
            vec3 col = palette(bandFreq + u_time * 0.1);
            
            // Bass frequencies (bottom) get warmer colors
            col = mix(vec3(1.0, 0.3, 0.1), col, bandFreq);
            // Treble frequencies (top) get cooler colors
            col = mix(col, vec3(0.1, 0.5, 1.0), smoothstep(0.5, 1.0, bandFreq));
            
            vec3 layerColor = col * bar;
            
            // Add glow on bass hits
            layerColor += vec3(1.0, 0.5, 0.2) * bar * u_bass * 0.2 * (1.0 - bandFreq);
            `,
            // 6. Segmented Rings
            // Donut-chart style ring segments representing frequency bands
            `
            vec2 p = uv;
            float r = length(p);
            float angle = atan(p.y, p.x);
            
            // Map angle to frequency (0-1)
            float fIndex = (angle + 3.14159) / 6.28318;
            float val = getFreq(fIndex);
            
            // Ring parameters
            float innerRadius = 0.25;
            float outerRadius = 0.65;
            
            // Create ring segment based on frequency
            float ringWidth = outerRadius - innerRadius;
            float ringVal = innerRadius + val * ringWidth;
            
            // Sharp ring edge
            float ring = smoothstep(0.03, 0.0, abs(r - ringVal));
            ring += smoothstep(0.02, 0.0, r - innerRadius) * smoothstep(innerRadius + 0.02, innerRadius, r);
            ring *= smoothstep(outerRadius + 0.02, outerRadius, r);
            
            // Add pulsing glow
            float glow = smoothstep(0.08, 0.0, abs(r - ringVal - 0.05)) * val * 0.5;
            
            // Color from palette
            vec3 layerColor = palette(fIndex + u_time * 0.2) * ring;
            layerColor += palette(fIndex * 0.5) * glow * u_bass;
            
            // Center fill
            float center = smoothstep(0.22, 0.0, r);
            layerColor += palette(u_time * 0.1) * center * 0.3 * u_mid;
            `
        ];
        return variations;
    }

    /* --- MODIFIERS --- */
    static getModifierVariations() {
        const variations = [
            // 1. Twist
            `
            float dist = length(uv);
            float angle = atan(uv.y, uv.x);
            angle += sin(dist * 10.0 - u_time) * 0.5 * u_bass;
            uv = vec2(cos(angle), sin(angle)) * dist;
            vec3 layerColor = vec3(0.0); 
            `,
            // 2. Pixelate
            `
            float blocks = 20.0 + sin(u_time)*10.0;
            vec2 blockUV = floor(uv * blocks) / blocks;
            uv = mix(uv, blockUV, u_bass); 
            vec3 layerColor = vec3(0.0);
            `,
            // 3. Fold
            `
            uv = abs(uv);
            uv -= 0.25;
            uv = rotate(uv, u_time * 0.1);
            vec3 layerColor = vec3(0.0);
            `
        ];
        return variations;
    }

    /* --- LIGHTNING --- */
    static getLightningVariations() {
        const variations = [
            // 1. Spectral Tesla
            // SAFE: Added safety to intensity division
            `
            float r = length(uv);
            float a = atan(uv.y, uv.x);
            float f = getFreq(abs(a) / 3.14159);
            float n = noise(uv * 10.0 + u_time * 5.0);
            float bolt = abs(a - (floor(a * 8.0) / 8.0) - sin(r * 20.0 + n * 5.0) * 0.05);
            float intensity = 0.01 / (bolt + 0.001) * f * 2.0;
            intensity *= smoothstep(f + 0.1, f, r);
            vec3 layerColor = vec3(0.6, 0.8, 1.0) * intensity;
            layerColor += palette(f + u_time) * intensity * 0.5;
            `,
            // 2. Waveform Bolt
            // SAFE: Added safety to bolt division
            `
            float wave = getFreq(abs(uv.x));
            float path = uv.y - (wave - 0.2) * sin(uv.x * 10.0 + u_time);
            path += (noise(vec2(uv.x * 20.0, u_time * 10.0)) - 0.5) * 0.1;
            float bolt = 0.005 / (abs(path) + 0.001);
            bolt *= (1.0 + u_bass * 2.0);
            vec3 layerColor = vec3(0.8, 0.9, 1.0) * bolt;
            layerColor += vec3(0.2, 0.4, 1.0) * bolt * 0.5;
            `,
            // 3. Chaos Storm
            // SAFE: Added safety to electricity division
            `
            vec2 p = uv * 2.0;
            p += vec2(noise(p + u_time), noise(p - u_time)) * u_bass;
            float val = 0.0;
            float amp = 1.0;
            for(int i=0; i<5; i++) {
                val += abs(sin(p.x * 5.0 + p.y * 2.0 + u_time * 2.0 + noise(p + u_time))) * amp;
                p *= 2.0;
                amp *= 0.5;
            }
            float electricity = 0.05 / (val * val + 0.001);
            vec3 col = mix(vec3(0.5, 0.1, 0.8), vec3(0.2, 0.8, 1.0), u_treble);
            vec3 layerColor = col * electricity * (1.0 + getFreq(0.5) * 3.0);
            `
        ];
        return variations;
    }

    /* --- PLASMA --- */
    static getPlasmaVariations() {
        const scale = (2.0 + Math.random() * 3.0).toFixed(1);
        return [
            // 1. Classic
            `
            vec2 p = uv * ${scale};
            float t = u_time + u_bass;
            float v = sin(p.x + t);
            v += sin(p.y + t);
            v += sin(p.x + p.y + t);
            v = (v + 3.0) / 6.0;
            vec3 layerColor = palette(v + u_mid);
            `,
            // 2. Liquid Noise
            `
            vec2 p = uv * 4.0;
            float n = noise(p + u_time * 0.5);
            n += noise(p * 2.0 - u_time) * 0.5;
            float ring = sin(n * 10.0 + u_time);
            vec3 layerColor = palette(n + u_bass * 0.5) * (0.5 + 0.5 * ring);
            `,
            // 3. Cellular
            `
            vec2 p = uv * 3.0;
            vec2 i_st = floor(p);
            vec2 f_st = fract(p);
            float m_dist = 1.0;
            for (int y= -1; y <= 1; y++) {
                for (int x= -1; x <= 1; x++) {
                    vec2 neighbor = vec2(float(x),float(y));
                    vec2 point = vec2(random(i_st + neighbor), random(i_st + neighbor + 1.0));
                    point = 0.5 + 0.5*sin(u_time + 6.2831*point);
                    vec2 diff = neighbor + point - f_st;
                    float dist = length(diff);
                    m_dist = min(m_dist, dist);
                }
            }
            vec3 layerColor = palette(m_dist + u_treble);
            layerColor += 1.0 - step(0.02, m_dist); 
            `,
            // 4. Plasma Ball (Fixed max() order)
            `
            vec2 p = uv * 2.0;
            vec2 v = p;
            float l = 0.0;
            vec3 c = vec3(0.0);
            l = abs(0.7 - dot(p,p));
            v = p * (1.0 - l) / 0.2;
            for(float i=0.0; i<8.0; i++) {
                c += (sin(vec3(v.x, v.y, v.y) * 2.0) + 1.0) * abs(v.x - v.y) * 0.2 + (u_treble * 1.5);
                v += cos(v.yx * i + vec2(0.0, i) + u_time) / (i + 1.0) + 0.7;
            }
            vec3 glow = exp(p.y * vec3(1.0, -1.0, -2.0)) * exp(-4.0 * l);
            // SAFE: max(c, 0.1) correct order
            vec3 layerColor = tanh(glow / max(c, 0.1)) * (1.0 + u_bass);
            `,
            // 5. Nebula (Robust)
            `
            float n = fbm(uv * 3.0 + u_time * 0.1, 4);
            // SAFE: Dist never 0
            float dist = length(uv) + 0.1;
            float core = 1.0 / dist;
            vec3 layerColor = palette(n * 2.0) * n * core * 0.5 * (0.8 + u_mid * 0.5);
            `
        ];
    }
    
    /* --- FRACTALS --- */
    static getFractalVariations() {
        const variations = [
            // 1. Julia
            `
            vec2 p = uv * 1.5;
            vec2 c = vec2(sin(u_time*0.3), cos(u_time*0.4));
            float i_val = 0.0;
            for(int i=0; i<6; i++) {
                p = vec2(p.x*p.x - p.y*p.y, 2.0*p.x*p.y) + c;
                if(length(p) > 4.0) break;
                i_val += 1.0;
            }
            vec3 layerColor = palette(i_val * 0.1 + u_time);
            `,
            // 2. Mandelbrot Zoom
            `
            vec2 p = uv;
            p = p / (u_scale + 0.1) - vec2(0.7, 0.0); 
            vec2 c = p;
            vec2 z = vec2(0.0);
            float iter = 0.0;
            for(int i=0; i<8; i++) {
                z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
                if(length(z) > 2.0) break;
                iter += 1.0;
            }
            vec3 layerColor = palette(iter/8.0 + u_time * 0.2) * u_bass;
            `,
            // 3. KIFS
            `
            vec2 p = uv * 2.0;
            float a = 0.0;
            for(int i=0; i<4; i++) {
                p = abs(p) / dot(p,p) - 0.5;
                p = rotate(p, u_time * 0.2);
                a += length(p);
            }
            vec3 layerColor = palette(a * 0.2 + u_mid) * ((1.5 * u_bass) + 0.5 * sin(a));
            `,
            // 4. Fractal Grid (Xor)
            // SAFE: Added safety to division
            `
            vec2 p = uv * 20.0;
            vec3 col = vec3(0.0);
            float t = u_time + u_bass * 2.0;
            for(float i=0.0; i<10.0; i++) {
                vec3 pal = cos(p.x + vec3(2.0, 1.0, 0.0)) + 1.0;
                vec2 distortion = sin(p + t).yx;
                float d = length(sin(p + distortion + u_mid * 0.3));
                col += pal / max(0.001, d - u_bass * 0.15) / 0.2;
                p *= mat2(0.8, -0.6, 0.6, 0.8);
            }
            vec3 layerColor = tanh(col * col / 20000.0);
            `,
            // 5. Newton Fractal
            // Mathematical root-finding fractal with colorful basins
            `
            vec2 p = uv * 3.0;
            vec2 z = p;
            float t = u_time * 0.2;
            
            // Newton's method for z^3 - 1 = 0
            for(int i=0; i<12; i++) {
                vec2 z2 = z * z;
                vec2 z3 = z2 * z;
                // Derivative: 3*z^2
                vec2 deriv = 3.0 * z2;
                // Newton iteration: z = z - f(z)/f'(z)
                // f(z) = z^3 - 1, but we add rotation for variety
                vec2 f = z3 - vec2(cos(t), sin(t)) * 0.5;
                z = z - f / (deriv + 0.001);
            }
            
            // Color based on which root it converges to
            float r = length(z - vec2(1.0, 0.0));
            float g = length(z - vec2(-0.5, 0.866));
            float b = length(z - vec2(-0.5, -0.866));
            
            vec3 col = vec3(1.0 / (r + 0.1), 1.0 / (g + 0.1), 1.0 / (b + 0.1));
            col = tanh(col * 0.3);
            
            // Audio reactivity
            vec3 layerColor = col * (0.8 + u_bass * 0.5);
            `,
            // 6. Sierpinski Gasket
            // Recursive triangular fractal pattern
            `
            vec2 p = uv * 2.0;
            p += vec2(sin(u_time * 0.3), cos(u_time * 0.4)) * 0.1;
            
            vec3 col = vec3(0.0);
            float scale = 1.0;
            
            // Iterated function system for Sierpinski
            for(int i=0; i<8; i++) {
                // Fold space
                p = abs(p);
                
                // Rotate and scale
                float angle = u_time * 0.1 + float(i) * 0.2;
                p = rotate(p, angle);
                
                // Scale
                p = p * 2.0 - vec2(1.0, 0.0);
                
                // Accumulate color
                vec3 pal = cos(p.x + vec3(1.0, 2.0, 3.0) + u_time * 0.2) + 1.0;
                col += pal * scale * 0.1;
                
                scale *= 0.5;
            }
            
            // Audio reactivity
            col *= (0.5 + u_mid * 0.5);
            vec3 layerColor = tanh(col * 0.5);
            `,
            // 7. Burning Ship
            // Variant of Mandelbrot with ship-like shapes
            `
            vec2 p = uv * 3.0 - vec2(1.5, 0.0);
            
            // Animate the c parameter
            vec2 c = vec2(
                -0.4 + sin(u_time * 0.2) * 0.1,
                -0.5 + cos(u_time * 0.15) * 0.1
            );
            
            vec2 z = vec2(0.0);
            float iter = 0.0;
            
            // Burning ship iteration: z = (|Re(z)| + i|Im(z)|)^2 + c
            for(int i=0; i<16; i++) {
                float x = (z.x * z.x - z.y * z.y) + c.x;
                float y = (2.0 * abs(z.x) * abs(z.y)) + c.y;
                z = vec2(x, y);
                
                if(length(z) > 4.0) break;
                iter += 1.0;
            }
            
            // Color based on iteration count
            float smoothIter = iter - log2(log2(dot(z, z))) + 4.0;
            vec3 col = palette(smoothIter * 0.1 + u_time * 0.1);
            
            // Dark inside, bright outside
            col *= smoothstep(0.0, 1.0, iter / 16.0);
            
            // Audio boost
            vec3 layerColor = col * (0.7 + u_bass * 0.8);
            `,
        // 8. Mainframe (Xor)
            `
            // abs(uv) creates the 4-way kaleidoscopic mirroring effect
            // Division by 0.4 in the original is equivalent to multiplying by 2.5
            vec2 p = abs(uv) * 2.5;
            vec3 col = vec3(0.0);
            
            // Audio reactive time 
            float t = u_time * 1.5 + u_bass * 2.0;

            for(float i = 1.0; i <= 9.0; i++) {
                vec2 v = p - i * 0.2;
                
                // Inner structural loop
                for(float f = 1.0; f <= 7.0; f++) {
                    // Calculate grid-like offsets using ceil()
                    // v.yx swizzles the vector to swap X and Y components
                    vec2 cell = ceil(v.yx + i * 0.1) * 9.0 + t;
                    vec2 offset = sin(cell) / f;
                    
                    // Add offset and swap X/Y again to create the weaving matrix effect
                    v = (v + offset).yx;
                }
                
                float l = length(sin(v));
                
                // Color palette (converted from golfed vec4 to standard vec3)
                vec3 pal = cos(i * 0.3 + l - vec3(4.0, 5.0, 6.0)) + 1.0;
                
                // SAFE: Prevent division by zero using max()
                // Original used .02 / l / l which equals .02 / (l * l)
                col += 0.02 * pal / max(0.0001, l * l);
            }
            
            float intens = 1.0;
            #ifdef u_intensity
                intens = u_intensity;
            #endif
            
            // Because we don't have backbuffer trails, we pad the color intensity slightly 
            // and use u_mid to make the data-streams pulse beautifully with the beat.
            vec3 layerColor = max(tanh(col * intens * (1.2 + u_mid * 0.8)), 0.0);
            `
        ];
        return variations;
    }
    
    /* --- TUNNELS --- */
    static getTunnelVariations() {
        const variations = [
            // 1. Cylindrical
             `
            float r = 1.0/length(uv) + u_time;
            float a = atan(uv.y, uv.x);
            float v = sin(r * 10.0 + u_bass) * cos(a * 8.0);
            vec3 layerColor = palette(v * 0.5 + 0.5);
             `,
            // 2. Box
            `
            vec2 p = abs(uv);
            float maxAx = max(p.x, p.y);
            float r = 0.1 / maxAx + u_time * 0.5;
            float squares = step(0.5, sin(r * 20.0));
            vec3 layerColor = vec3(squares) * palette(r);
            layerColor *= maxAx * 2.0; 
            `,
            // 3. Warp Speed
            `
            float r = length(uv);
            float a = atan(uv.y, uv.x);
            float stars = 0.0;
            for(float i=1.0; i<4.0; i++) {
                float t = u_time * i + 100.0;
                float depth = fract(1.0/r + t);
                float size = 0.05 * i * r;
                float angle_seed = floor(a * 10.0 * i);
                if(random(vec2(angle_seed, floor(depth*10.0))) > 0.95) {
                     stars += 1.0 / (abs(fract(depth*10.0) - 0.5) * 20.0);
                }
            }
            vec3 layerColor = vec3(stars) * (0.5 + 0.5*u_bass);
            `,
            // 4. Hyper Tunnel
            `
            vec3 rayDir = normalize(vec3(uv, -1.0));
            vec3 p = vec3(0.0);
            vec3 col = vec3(0.0);
            float z = 0.0;
            float t = u_time * 2.0;
            for(int i=0; i<20; i++) {
                p = z * rayDir;
                vec3 a = p;
                for(float j=2.0; j<7.0; j++) {
                    a -= sin(a * j + t + float(i)).yzx / j;
                }
                vec3 ap = abs(p);
                float d_box = abs(2.0 - max(ap.x, ap.y)); 
                float s = a.z + a.y - t;
                float d_detail = abs(cos(s)) / 7.0;
                float d = d_box + d_detail;
                vec3 pal = cos(vec3(s - z) + vec3(0.0, 1.0, 8.0)) + 1.0;
                col += pal / max(0.001, d); 
                z += max(0.05, d);
            }
            vec3 layerColor = tanh(col * 0.005);
            `,
            // 5. Bio-Tunnel (Xor)
            `
            vec3 rayDir = normalize(vec3(uv, -1.0));
            vec3 p = vec3(0.0);
            vec4 col = vec4(0.0);
            float z = 0.0;
            float d = 0.0;
            float t = u_time + u_bass * 4.0;
            for(float i=0.0; i<20.0; i++) {
                p = z * rayDir;
                float angle = atan(p.y / 0.2, p.x) * 2.0;
                float depth = p.z / 3.0;
                float radius = length(p.xy) - 5.0 - z * 0.2;
                p = vec3(angle, depth, radius);
                for(float j=1.0; j<7.0; j++) {
                    p += sin(p.yzx * j + t + 0.3 * i) / j;
                }
                vec4 distVec = vec4(0.4 * cos(p) - 0.4, p.z);
                d = length(distVec);
                z += d;
                vec4 pal = cos(p.x + i * 0.4 + z + vec4(6.0, 1.0, 2.0, 0.0)) + (1.0 + u_treble);
                col += pal / max(0.001, (d + u_bass * 0.5)); 
            }
            vec3 layerColor = tanh(col.rgb * col.rgb / 400.0);
            `
        ];
        return variations;
    }
    
    /* --- GEOMETRY --- */
    static getGeometricVariations() {
        const variations = [
            // 1. Sacred Geometry
            `
            vec2 p = abs(uv) - 0.5;
            float d = length(p);
            float s = sin(d * 20.0 - u_time * 4.0 + u_bass);
            s = smoothstep(0.4, 0.5, s);
            vec3 layerColor = palette(d) * s;
            `,
            // 2. Hexagonal Grid
            `
            vec2 p = uv * 5.0;
            vec2 q = vec2( p.x * 2.0*0.5773503, p.y + p.x*0.5773503 );
            vec2 pi = floor(q);
            vec2 pf = fract(q);
            float v = mod(pi.x + pi.y, 2.0);
            float ca = step(1.0, max(abs(pf.x-0.5)*1.5 + abs(pf.y-0.5), abs(pf.y-0.5)*2.0));
            vec3 layerColor = vec3(ca) * palette(pi.x*0.1 + u_time);
            `,
            // 3. Rotating Crosses
            `
            vec2 p = fract(uv * 4.0) - 0.5;
            p = rotate(p, u_time + u_bass);
            float crossShape = min(abs(p.x), abs(p.y));
            float mask = smoothstep(0.1, 0.09, crossShape);
            vec3 layerColor = mask * palette(uv.x + uv.y + u_time);
            `,
            // 4. Geode (Xor)
            `
            vec3 p = vec3(0.0);
            vec3 v = vec3(0.0);
            vec3 rayDir = normalize(vec3(uv, -1.0));
            vec4 o = vec4(0.0);
            float z = 0.0;
            float d = 0.0;
            v = normalize(cos(u_time * 0.25 + vec3(0.0, 1.0, 4.0)));
            for(float i=0.0; i<40.0; i++) {
                p = z * rayDir;
                float dotP = dot(v, p);
                p = dotP * v + cross(v, p);
                p.z -= u_time;
                vec3 folded = abs(fract(p) - 0.5);
                p += folded.yzx - sin(z * 0.7);
                d = 0.3 * length(min(p, p.yzx));
                vec4 colShift = cos(i * 0.2 + u_time + vec4(0.0, 1.0, 3.0, 0.0)) + 1.0;
                o += colShift / max(0.001, d);
                z += d;
            }
            vec3 layerColor = tanh(o.rgb / 2000.0) * (1.0 + u_treble);
            `
        ];
        return variations;
    }
    
    /* --- FLUID --- */
    static getFluidVariations() {
        const variations = [
            // 1. FBM Smoke
            `
            vec2 p = uv * 3.0;
            float n = noise(p + vec2(u_time*0.2));
            n += noise(p * 2.0 - vec2(u_time*0.4)) * 0.5;
            vec3 layerColor = palette(n + u_bass) * n;
            `,
            // 2. Oil Slick
            `
            vec2 p = uv * 2.0;
            for(int i=1; i<4; i++) {
                float t = u_time * float(i) * 0.2;
                p += vec2(0.7/float(i)*sin(float(i)*p.y + t + 0.3*float(i)) + 0.8, 
                          0.4/float(i)*sin(float(i)*p.x + t + 0.3*float(i) + 1.6));
            }
            vec3 layerColor = vec3(0.5*sin(p.x)+0.5, 0.5*sin(p.y)+0.5, sin(p.x+p.y));
            `,
            // 3. Reaction Diffusion
            `
            float d = length(uv);
            float u = noise(uv * 5.0 + u_time);
            float v = noise(uv * 10.0 - u_time);
            float f = 0.5 + 0.5 * sin(10.0 * (u - v));
            vec3 layerColor = mix(vec3(0.1, 0.0, 0.2), vec3(0.0, 1.0, 0.8), f) * (1.0-d);
            `,
            // 4. Alien Oil (Xor)
            `
            vec4 o = vec4(uv, 1.0, 1.0);
            for(int i=0; i<9; i++) {
                vec4 s = sin(o * 3.0 - o.yxwz + u_time * 0.1);
                o += s;
            }
            vec3 layerColor = 1.0 - exp(-o.xyz * 0.1 * (1.0 + u_mid));
            `,
             // 5. Vapor 2 (Xor)
             `
             vec3 p = vec3(0.0);
             vec4 o = vec4(0.0);
              vec3 rayDir = normalize(vec3(uv.x, -abs(uv.y), -1.0));
             float z = 0.0;
             float f = 0.0;
             for(float i=0.0; i<60.0; i++) {
                 p = z * rayDir;
                 for(float j=1.0; j<5.0; j++) {
                     p += sin(p.zxy * j + j - u_time) / j;
                 }
                 f = 0.01 + 0.1 * abs(dot(sin(p * 0.7), cos(p).yzx));
                 z += f;
                 o += sin(p.y - u_time + vec4(6.0, 1.0, 2.0, 3.0)) * f + f;
             }
             vec3 layerColor = tanh(o.rgb * o.rgb / 100.0) * (0.5 + u_bass);
             `,
             `
            vec3 rayDir = normalize(vec3(uv, -1.0));
            vec3 p = vec3(0.0);
            vec3 col = vec3(0.0);
            float z = 0.0;
            float d = 0.0;
            
            // Audio reactive time 
            float t = u_time + u_bass * 1.5;

            for(float i = 1.0; i <= 30.0; i++) {
                p = z * rayDir;
                
                // Inner volumetric distortion loop
                for(float j = 1.0; j <= 9.0; j++) {
                    p += 0.4 * sin(p.yzx * j - z + t + i) / j + 0.5;
                }
                
                // Shape bounds function
                vec4 distVec = vec4(abs(p.y + p.z * 0.5), sin(p - z) / 7.0);
                d = length(distVec) / (4.0 + z * z / 100.0);
                
                // Original code effectively evaluates z += d *before* color division
                z += d;
                
                vec3 pal = 0.9 + sin(i * 0.1 - vec3(6.0, 1.0, 2.0));
                
                // SAFE: Ensure denominator is never pure zero
                float denom = max(0.001, d * d * z);
                
                vec3 glow1 = pal / denom;
                vec3 glow2 = (d * z) / vec3(4.0, 2.0, 1.0); 
                
                col += glow1 + glow2;
            }
            
            float intens = 1.0;
            #ifdef u_intensity
                intens = u_intensity;
            #endif
            
            // Scaled by 2000 as per original (o / 2e3), padded with gentle audio dynamics
            vec3 layerColor = tanh((col / 2000.0) * intens * (1.0 + u_mid * 0.2));
            `
        ];
        return variations;
    }
    
    /* --- CRYSTAL --- */
    static getCrystalVariations() {
        const variations = [
            // 1. Radial Facets
            `
            vec2 p = uv;
            float a = atan(p.y, p.x);
            float r = length(p);
            float c = cos(a * 6.0);
            float col = smoothstep(0.1, 0.2, abs(c - r * 4.0 + sin(u_bass)));
            vec3 layerColor = palette(r * 2.0) * col;
            `,
            // 2. Shattered Glass
            `
            vec2 p = uv * 3.0;
            vec2 i = floor(p);
            vec2 f = fract(p);
            float n = random(i); 
            float glass = smoothstep(0.0, 0.1, abs(f.x - f.y + n - 0.5));
            vec3 layerColor = vec3(0.8, 0.9, 1.0) * glass * (0.5 + 0.5 * sin(n * 10.0 + u_time));
            `,
            // 3. Isometric Cubes
            `
            vec2 p = uv * 10.0;
            vec2 grid = fract(p) - 0.5;
            float d = max(abs(grid.x), abs(grid.y));
            float cube = smoothstep(0.4, 0.45, d);
            vec3 layerColor = vec3(cube) * palette(floor(p.x) * 0.1 + u_time);
            `,
            // 4. Ethereal Gem (Xor)
            `
            vec3 p = vec3(0.0);
            vec3 q = vec3(0.0);
            vec4 col = vec4(0.0);
            float j = 0.0;
            float t = u_time * 0.5 + u_bass * 2.0;
            for(float i=1.0; i>0.0; i-=0.02) {
                p = vec3(uv * 2.0, 0.0); 
                float d = i - dot(p, p);
                p.z += sqrt(max(d, 0.0001));
                float currentZ = p.z; 
                p /= 2.0 + p.z;
                p.xz = rotate(p.xz, t);
                q += p;
                float tex = dot(cos(q), sin(q.yzx)) / 0.3;
                j = cos(j) * tex;
                float pattern = pow(j * 0.5 + 0.5, 8.0);
                vec4 pal = sin(i * 30.0 + vec4(0.0, 1.0, 2.0, 3.0)) + 1.0;
                col += pow(currentZ * currentZ, 0.2) * i * pattern * pal / 8.0;
            }
            vec3 layerColor = col.rgb * col.rgb;
            `
        ];
        return variations;
    }
    
    /* --- GALAXY --- */
    static getGalaxyVariations() {
        const variations = [
            // 1. Spiral Arms
            `
            vec2 p = uv;
            float r = length(p);
            float a = atan(p.y, p.x);
            float arm = sin(a * 3.0 + r * 10.0 - u_time);
            float gal = exp(-r * 2.0) * (1.0 + arm * 0.5);
            vec3 layerColor = palette(r + u_time*0.1) * gal * (1.0+u_bass);
            `,
            // 2. Nebula
            `
            float n = fbm(uv * 3.0 + u_time * 0.1, 4);
            float core = 1.0 / (length(uv) + 0.1);
            vec3 layerColor = palette(n * 2.0) * n * core * 0.5;
            `,
            // 3. Black Hole
            `
            float r = length(uv);
            float eventHorizon = smoothstep(0.1, 0.12, r);
            float disk = 1.0 / abs(r - 0.3 + sin(atan(uv.y, uv.x)*2.0 + u_time*3.0)*0.05);
            disk = clamp(disk * 0.05, 0.0, 1.0);
            vec3 layerColor = vec3(1.0, 0.6, 0.2) * disk * eventHorizon;
            `,
            // 4. Quasar 3 (Xor)
            `
            vec3 p;
            vec3 a;
            vec3 rayDir = normalize(vec3(uv, -1.0));
            vec4 o = vec4(0.0);
            float z = 0.0;
            float d = 0.0;
            float s = 0.0;
            for(float i=0.0; i<60.0; i++) {
                p = z * rayDir;
                p.z += 9.0;
                a = p;
                a -= 0.6;
                a = mix(dot(a, p) * a, p, cos(s - u_time));
                a -= sin(s) * cross(a, p);
                s = sqrt(length(a - a.zxy));
                for(float j=0.0; j<5.0; j++) {
                    a += cos(a * j + u_time).yzx / (j + 1.0);
                }
                d = dot(a, a) / (length(a) + 0.001); 
                z += sqrt(max(d, -d * 0.1)) * s / 14.0;
                o += vec4(s, 1.0, z/5.0, 1.0) / (s*s + 0.01) * (i / 100.0);
            }
            vec3 layerColor = tanh(o.rgb * o.rgb / 4000.0) * (1.0 + u_mid);
            `
        ];
        return variations;
    }

    /* --- PARTICLES --- */
    static getParticleVariations() {
        const variations = [
            // 1. Starfield
            `
            float stars = 0.0;
            for(int i=0; i<10; i++) {
                vec2 pos = vec2(random(vec2(float(i))), random(vec2(float(i)*1.5))) - 0.5;
                pos *= 2.0;
                float flash = sin(u_time * (1.0+float(i)) + float(i));
                float d = length(uv - pos);
                stars += 0.005 / d * (0.5 + 0.5*flash);
            }
            vec3 layerColor = vec3(stars);
            `,
           
            // 2. Grid Pulsar
            `
            vec2 g = fract(uv * 5.0) - 0.5;
            vec2 id = floor(uv * 5.0);
            float d = length(g);
            float pulse = sin(u_time * 5.0 + length(id)) * 0.5 + 0.5;
            float dot = smoothstep(0.3 * pulse, 0.2 * pulse, d);
            vec3 layerColor = palette(length(id) * 0.1) * dot;
            `,
            // 3. Satellites (Xor)
            `
            vec2 p = uv * 10.0;
            vec2 s = vec2(3.0, 2.0 - sin(u_time * 0.25));
            vec3 acc = vec3(0.0);
            float ca = cos(u_time * 0.25);
            float sa = sin(u_time * 0.25);
            mat2 m = mat2(ca, -sa, sa, ca);
            for(float i=0.0; i<9.0; i++) {
                m *= mat2(0.8, -0.6, 0.6, 0.8); 
                vec2 v = m * (p / s);
                vec2 fv = fract(v) - 0.5;
                float d = length(fv * m * s) - 0.2 * sin(length(v) - u_time) - 0.2;
                float shape = smoothstep(0.1, 0.0, d);
                vec3 col = (cos(i + vec3(0.0, 0.6, 1.2)) + 1.0) * 0.5;
                acc += shape * col * (1.0 - acc);
            }
            vec3 layerColor = acc * (1.0 + u_treble);
            `,
            // 4. Particles (Xor)
            `
            vec3 rayDir = normalize(vec3(uv, -1.0));
            vec3 p = vec3(0.0);
            vec3 col = vec3(0.0);
            float z = 0.0;
            float d = 0.0;
            
            // Audio reactive time 
            float t = u_time * 1.5 + u_bass * 2.0;

            for(float i = 1.0; i <= 60.0; i++) {
                // 'f' defines a structural bounding depth scalar
                float f = abs(z - 5.0) * 0.05;
                
                // The original code packed a float and a vec3 into a vec4 just to get the length.
                // Unpacking it here is cleaner, prevents alpha-channel issues, and performs better:
                float a = dot(sin(p), sin(p / 0.6)) - length(p) + 5.0;
                vec3 b = sin(p / 0.1 + t) * cos(p.yzx / 0.1 + t) * 0.3;
                
                // Calculate equivalent distance safely
                float dist = sqrt(a * a + dot(b, b));
                
                d = 0.4 * max(f, dist - f);
                z += d;
                
                // Color palette (d / 0.2 is replaced with d * 5.0 for multiplication speed)
                vec3 pal = cos(p.y + i * 0.2 + d * 5.0 + vec3(0.0, 1.0, 2.0)) + 1.1;
                
                // SAFE: Prevent divide-by-zero causing black pixels or NaN artifacts
                col += pal / max(0.001, d);
                
                // Advance ray position for the NEXT iteration 
                // (This perfectly mimics Xor's third argument in the golfed for-loop)
                p = z * rayDir;
                p.z += 9.0; 
            }
            
            float intens = 1.0;
            #ifdef u_intensity
                intens = u_intensity;
            #endif
            
            // Original used tanh(o*o/3e5)
            // We scale it dynamically based on the u_intensity and u_mid audio
            vec3 layerColor = tanh((col * col / 300000.0) * intens * (1.0 + u_mid * 0.2));
            `
        ];
        return variations;
    }
    
    /* --- WAVES --- */
    static getWaveVariations() {
        const variations = [
             // 1. Interference
             `
             float w = sin(uv.x * 10.0 + u_time) + sin(uv.y * 8.0 + u_time);
             float b = smoothstep(0.0, 0.1, abs(w));
             vec3 layerColor = palette(w * 0.2) * (1.0-b);
             `,
             // 2. Ripples
             `
             float d = length(uv);
             float ripple = sin(d * 30.0 - u_time * 5.0);
             vec3 layerColor = vec3(0.0, 0.5, 1.0) * (ripple * 0.5 + 0.5) * u_bass;
             `,
             // 3. Scanlines
             `
             float scan = sin(uv.y * 100.0 + u_time * 10.0);
             float wave = sin(uv.x * 5.0 + u_time) * 0.2;
             float beam = smoothstep(0.01, 0.0, abs(uv.y - wave));
             vec3 layerColor = vec3(0.2, 1.0, 0.2) * (beam + scan * 0.1);
             `,
             // 4. Sliding Interference (Xor)
            `
            vec2 p = uv * 4.0; // Scale up
            float PI = 3.14159;
            float t = u_time * 2.0 + u_bass * 2.0; // Audio reactive speed

            // 1. Color Palette Logic
            vec3 pal = cos(p.x / 0.6 - p.y + vec3(6.0, 1.0, 2.0));

            // 2. Sliding Bands Logic
            float bandIndex = round(p.y / PI) * PI;
            float direction = cos(bandIndex); 
            float slide = cos(p.x - t * direction + (u_treble * 0.5));

            // 3. Vertical Interference
            float structure = cos(p.y);

            // Combine
            vec3 col = 0.3 * pal * slide / (structure + 0.01) + u_mid * 0.3;

            vec3 layerColor = tanh(col);
            `
        ];
        return variations;
    }

    static getEffectWithVariant(effectId) {
        const effects = this.getAvailableEffects();
        const effect = effects.find(e => e.id === effectId);
        
        if (!effect) {
            return { code: '', variantName: 'Unknown' };
        }
        
        // Get the variant names array
        const variantNames = effect.variantNames();
        const codeArray = effect.code;
        
        // Randomly select a variant index - this determines BOTH the code and the name
        const variantIndex = Math.floor(Math.random() * variantNames.length);
        
        return {
            code: codeArray[variantIndex],
            variantName: variantNames[variantIndex]
        };
    }

    static getBioMathVariantNames() {
        return ['Xor Neural', 'Gyroid Lattice', 'Crystalline Lattice', 'Hypnotic Spiral', 'Alien Terrain', 'Digital Sphere', 'Orchard'];
    }

    static getSpectrumVariantNames() {
        return ['Circular EQ', 'Digital Bars', 'Spectrum Terrain', 'Waterfall Spectrum', 'Horizontal Bars', 'Segmented Rings'];
    }

    static getModifierVariantNames() {
        return ['Twist', 'Pixelate', 'Fold'];
    }

    static getPlasmaVariantNames() {
        return ['Classic', 'Liquid Noise', 'Cellular', 'Plasma Ball', 'Nebula'];
    }

    static getFractalVariantNames() {
        return ['Julia', 'Mandelbrot Zoom', 'KIFS', 'Fractal Grid', 'Newton Fractal', 'Sierpinski Gasket', 'Burning Ship', 'Mainframe'];
    }

    static getTunnelVariantNames() {
        return ['Cylindrical', 'Box', 'Warp Speed', 'Hyper Tunnel', 'Bio-Tunnel'];
    }

    static getGeometricVariantNames() {
        return ['Sacred Geometry', 'Hexagonal Grid', 'Rotating Crosses', 'Geode'];
    }

    static getFluidVariantNames() {
        return ['FBM Smoke', 'Oil Slick', 'Reaction Diffusion', 'Alien Oil', 'Vapor', 'Reef'];
    }

    static getLightningVariantNames() {
        return ['Spectral Tesla', 'Waveform Bolt', 'Chaos Storm'];
    }

    static getCrystalVariantNames() {
        return ['Radial Facets', 'Shattered Glass', 'Isometric Cubes', 'Ethereal Gem'];
    }

    static getGalaxyVariantNames() {
        return ['Spiral Arms', 'Nebula', 'Black Hole', 'Quasar'];
    }

    static getParticleVariantNames() {
        return ['Starfield', 'Grid Pulsar', 'Satellites', 'Particles'];
    }

    static getWaveVariantNames() {
        return ['Interference', 'Ripples', 'Scanlines', 'Sliding Interference'];
    }
}
