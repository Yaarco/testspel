/**
 * GLSL for the three things we draw. Everything is blended additively,
 * so draw order does not matter and nothing needs sorting.
 */

/**
 * Glowing glass surfaces. Each vertex carries its distance to every edge of
 * its face (up to eight); distance to a line is linear across a plane, so the
 * interpolated minimum is the exact distance to the nearest edge for any pixel.
 */
export const SURFACE_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uViewProjection;
    uniform float uHighlightIndex;
    in vec3 aPosition;
    in vec3 aColor;
    in vec4 aEdgesA;
    in vec4 aEdgesB;
    in float aFill;
    in float aLine;
    in float aIndex;
    out vec3 vWorld;
    out vec3 vColor;
    out vec4 vEdgesA;
    out vec4 vEdgesB;
    out float vFill;
    out float vLine;
    out float vHighlight;
    void main() {
      gl_Position = uViewProjection * vec4(aPosition, 1.0);
      vWorld = aPosition;
      vColor = aColor;
      vEdgesA = aEdgesA;
      vEdgesB = aEdgesB;
      vFill = aFill;
      vLine = aLine;
      vHighlight = abs(aIndex - uHighlightIndex) < 0.5 ? 1.0 : 0.0;
    }`,
  fragment: `#version 300 es
    precision highp float;
    uniform vec3 uEye;
    uniform float uTime;
    uniform float uViewDistance;
    in vec3 vWorld;
    in vec3 vColor;
    in vec4 vEdgesA;
    in vec4 vEdgesB;
    in float vFill;
    in float vLine;
    in float vHighlight;
    out vec4 outColor;
    void main() {
      vec4 nearest = min(vEdgesA, vEdgesB);
      float edge = min(min(nearest.x, nearest.y), min(nearest.z, nearest.w));
      float pixel = fwidth(edge);
      float line = 1.0 - smoothstep(0.0, 1.5 * pixel, edge);
      float halo = exp(-edge / max(6.0, 3.0 * pixel));
      float pulse = vHighlight * (0.5 + 0.5 * sin(uTime * 6.0));
      float fade = clamp(1.0 - distance(vWorld, uEye) / uViewDistance, 0.0, 1.0);

      vec3 glow = vColor * (vFill * (1.0 + pulse) + halo * vLine * (0.35 + pulse * 0.6));
      vec3 rim = mix(vColor, vec3(1.0), 0.35) * line * vLine * 0.9;
      outColor = vec4((glow + rim) * fade, 1.0);
    }`,
};

/** Stars and comet trails: round, soft points on the sky sphere. */
export const POINT_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uSkyViewProjection;
    uniform float uSkyRadius;
    uniform float uPixelRatio;
    in vec3 aDirection;
    in float aSize;
    in vec4 aColor;
    out vec4 vColor;
    void main() {
      gl_Position = uSkyViewProjection * vec4(aDirection * uSkyRadius, 1.0);
      gl_PointSize = aSize * uPixelRatio;
      vColor = aColor;
    }`,
  fragment: `#version 300 es
    precision mediump float;
    in vec4 vColor;
    out vec4 outColor;
    void main() {
      float r = length(gl_PointCoord * 2.0 - 1.0);
      float falloff = 1.0 - smoothstep(0.2, 1.0, r);
      outColor = vec4(vColor.rgb * vColor.a * falloff, 1.0);
    }`,
};

/** Galaxies: textured quads on the sky sphere, sampled from one atlas. */
export const SPRITE_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uSkyViewProjection;
    uniform float uSkyRadius;
    in vec3 aDirection;
    in vec2 aUv;
    out vec2 vUv;
    void main() {
      gl_Position = uSkyViewProjection * vec4(aDirection * uSkyRadius, 1.0);
      vUv = aUv;
    }`,
  fragment: `#version 300 es
    precision mediump float;
    uniform sampler2D uAtlas;
    in vec2 vUv;
    out vec4 outColor;
    void main() {
      vec4 texel = texture(uAtlas, vUv);
      outColor = vec4(texel.rgb * texel.a * 0.8, 1.0);
    }`,
};

/**
 * Shared parts of the textured map shaders: linear fog, alpha test,
 * and cubemap reflection with its tint and mask.
 */
const MAP_FRAGMENT_COMMON = `
    uniform vec3 uEye;
    uniform vec3 uFogColor;
    uniform vec3 uFog;            // start, end, max density
    uniform float uFogEnabled;
    uniform float uAlphaTest;
    uniform float uAlpha;
    uniform samplerCube uEnvmap;
    uniform sampler2D uEnvmapMask;
    uniform float uHasEnvmap;
    uniform float uEnvmapMaskMode;  // 0 none, 1 mask texture, 2 base alpha, 3 normal map alpha
    uniform vec3 uEnvmapTint;
    uniform float uSelfIllum;

    vec3 reflection(vec3 normal, vec3 world, vec4 base, float normalAlpha, vec2 uv) {
      if (uHasEnvmap < 0.5) return vec3(0.0);
      vec3 mask = vec3(1.0);
      if (uEnvmapMaskMode > 0.5 && uEnvmapMaskMode < 1.5) mask = texture(uEnvmapMask, uv).rgb;
      else if (uEnvmapMaskMode > 1.5 && uEnvmapMaskMode < 2.5) mask = vec3(base.a);
      else if (uEnvmapMaskMode > 2.5) mask = vec3(normalAlpha);
      vec3 direction = reflect(normalize(world - uEye), normal);
      return texture(uEnvmap, direction).rgb * uEnvmapTint * mask;
    }

    vec4 finish(vec3 color, float alpha, vec3 world) {
      if (alpha < uAlphaTest) discard;
      float fog = uFogEnabled * clamp((distance(world, uEye) - uFog.x) / max(uFog.y - uFog.x, 1.0), 0.0, uFog.z);
      return vec4(mix(color, uFogColor, fog), alpha * uAlpha);
    }`;

/**
 * World faces and displacements, as LightmappedGeneric and WorldVertexTransition:
 * base texture (blended with a second one by displacement alpha), detail
 * texture, and the baked lightmap stored at half brightness for 2x overbright.
 * Bumped faces combine their three directional lightmaps using the normal map,
 * weighted by the bump basis.
 */
export const MAP_WORLD_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uViewProjection;
    in vec3 aPosition;
    in vec2 aUv;
    in vec2 aLightmapUv;
    in float aBlend;
    in float aBumpStep;
    in vec3 aNormal;
    in vec4 aTangent;
    out vec3 vWorld;
    out vec2 vUv;
    out vec2 vLightmapUv;
    out float vBlend;
    out float vBumpStep;
    out vec3 vNormal;
    out vec4 vTangent;
    void main() {
      gl_Position = uViewProjection * vec4(aPosition, 1.0);
      vWorld = aPosition;
      vUv = aUv;
      vLightmapUv = aLightmapUv;
      vBlend = aBlend;
      vBumpStep = aBumpStep;
      vNormal = aNormal;
      vTangent = aTangent;
    }`,
  fragment: `#version 300 es
    precision highp float;
    uniform sampler2D uBase;
    uniform sampler2D uBase2;
    uniform sampler2D uLightmap;
    uniform sampler2D uBump;
    uniform sampler2D uDetail;
    uniform float uHasBase;
    uniform float uHasBase2;
    uniform float uHasBump;
    uniform float uSsbump;
    uniform float uHasDetail;
    uniform float uDetailScale;
    uniform float uDetailBlend;
    uniform float uLit;
    uniform float uWater;
    uniform vec3 uColor;
    in vec3 vWorld;
    in vec2 vUv;
    in vec2 vLightmapUv;
    in float vBlend;
    in float vBumpStep;
    in vec3 vNormal;
    in vec4 vTangent;
    out vec4 outColor;
    ${MAP_FRAGMENT_COMMON}

    // The bump basis, in tangent space.
    const vec3 BASIS0 = vec3(0.81649658, 0.0, 0.57735027);
    const vec3 BASIS1 = vec3(-0.40824829, 0.70710678, 0.57735027);
    const vec3 BASIS2 = vec3(-0.40824829, -0.70710678, 0.57735027);

    void main() {
      vec4 base = uHasBase > 0.5 ? texture(uBase, vUv) : vec4(uColor, 1.0);
      if (uHasBase2 > 0.5) base = mix(base, texture(uBase2, vUv), clamp(vBlend, 0.0, 1.0));
      if (uHasDetail > 0.5) {
        vec3 detail = texture(uDetail, vUv * uDetailScale).rgb * 2.0;
        base.rgb *= mix(vec3(1.0), detail, uDetailBlend);
      }

      vec3 normal = normalize(vNormal);
      vec4 bump = uHasBump > 0.5 ? texture(uBump, vUv) : vec4(0.5, 0.5, 1.0, 1.0);
      vec3 tangentNormal = normalize(bump.xyz * 2.0 - 1.0);
      vec3 tangent = normalize(vTangent.xyz);
      vec3 bitangent = cross(normal, tangent) * vTangent.w;
      vec3 surfaceNormal = uHasBump > 0.5 && uSsbump < 0.5
        ? normalize(tangent * tangentNormal.x + bitangent * tangentNormal.y + normal * tangentNormal.z)
        : normal;

      vec3 light = vec3(1.0);
      if (uLit > 0.5) {
        light = texture(uLightmap, vLightmapUv).rgb;
        if (uHasBump > 0.5 && vBumpStep > 0.0) {
          vec3 lm1 = texture(uLightmap, vLightmapUv + vec2(vBumpStep, 0.0)).rgb;
          vec3 lm2 = texture(uLightmap, vLightmapUv + vec2(vBumpStep * 2.0, 0.0)).rgb;
          vec3 lm3 = texture(uLightmap, vLightmapUv + vec2(vBumpStep * 3.0, 0.0)).rgb;
          if (uSsbump > 0.5) {
            light = bump.r * lm1 + bump.g * lm2 + bump.b * lm3;
          } else {
            vec3 weights = clamp(vec3(dot(tangentNormal, BASIS0), dot(tangentNormal, BASIS1), dot(tangentNormal, BASIS2)), 0.0, 1.0);
            weights *= weights;
            light = (weights.x * lm1 + weights.y * lm2 + weights.z * lm3) / max(weights.x + weights.y + weights.z, 0.0001);
          }
        }
        light *= 2.0;
      }

      vec3 color = base.rgb * light;
      if (uSelfIllum > 0.5) color = mix(color, base.rgb, base.a);
      vec3 reflected = reflection(surfaceNormal, vWorld, base, bump.a, vUv);
      float alpha = base.a;
      if (uWater > 0.5) {
        // No refraction pass: blend the water tint with the reflection by fresnel.
        float facing = clamp(dot(normalize(uEye - vWorld), surfaceNormal), 0.0, 1.0);
        float fresnel = 0.2 + 0.8 * pow(1.0 - facing, 5.0);
        color = mix(uColor, reflected, fresnel);
        alpha = mix(1.0, 1.0 / max(uAlpha, 0.001), fresnel);
      } else {
        color += reflected;
      }
      outColor = finish(color, alpha, vWorld);
    }`,
};

/** Static props, as VertexLitGeneric: base texture times light baked per vertex, plus reflections. */
export const MAP_PROP_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uViewProjection;
    in vec3 aPosition;
    in vec2 aUv;
    in vec3 aLight;
    in vec3 aNormal;
    out vec3 vWorld;
    out vec2 vUv;
    out vec3 vLight;
    out vec3 vNormal;
    void main() {
      gl_Position = uViewProjection * vec4(aPosition, 1.0);
      vWorld = aPosition;
      vUv = aUv;
      vLight = aLight;
      vNormal = aNormal;
    }`,
  fragment: `#version 300 es
    precision highp float;
    uniform sampler2D uBase;
    uniform sampler2D uBump;
    uniform float uHasBase;
    uniform float uHasBump;
    uniform vec3 uColor;
    in vec3 vWorld;
    in vec2 vUv;
    in vec3 vLight;
    in vec3 vNormal;
    out vec4 outColor;
    ${MAP_FRAGMENT_COMMON}
    void main() {
      vec4 base = uHasBase > 0.5 ? texture(uBase, vUv) : vec4(uColor, 1.0);
      float normalAlpha = uHasBump > 0.5 ? texture(uBump, vUv).a : 1.0;
      vec3 color = base.rgb * vLight;
      if (uSelfIllum > 0.5) color = mix(color, base.rgb, base.a);
      color += reflection(normalize(vNormal), vWorld, base, normalAlpha, vUv);
      outColor = finish(color, base.a, vWorld);
    }`,
};

/** The map's 2D skybox: six textured faces around the camera, unaffected by fog. */
export const MAP_SKY_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uSkyViewProjection;
    in vec3 aDirection;
    in vec2 aUv;
    out vec2 vUv;
    void main() {
      gl_Position = uSkyViewProjection * vec4(aDirection, 1.0);
      vUv = aUv;
    }`,
  fragment: `#version 300 es
    precision mediump float;
    uniform sampler2D uBase;
    in vec2 vUv;
    out vec4 outColor;
    void main() {
      outColor = vec4(texture(uBase, vUv).rgb, 1.0);
    }`,
};

/**
 * Skinned models (first-person arms and weapons, characters), skinned on the GPU: bone matrices live in
 * a float texture (four texels per bone), so any bone count fits.
 * Lit like engine models (see modelLighting.js): an ambient cube in world
 * space plus a few directional lights with half-lambert wrap, summed in
 * linear light and shown in gamma space with the maps' overbright headroom.
 */
export const SKINNED_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uProjection;
    uniform mat4 uModelView;
    uniform highp sampler2D uBones;
    in vec3 aPosition;
    in vec3 aNormal;
    in vec2 aUv;
    in vec4 aJoints;
    in vec4 aWeights;
    out vec2 vUv;
    out vec3 vNormal;
    mat4 bone(float index) {
      int x = int(index) * 4;
      return mat4(texelFetch(uBones, ivec2(x, 0), 0), texelFetch(uBones, ivec2(x + 1, 0), 0),
                  texelFetch(uBones, ivec2(x + 2, 0), 0), texelFetch(uBones, ivec2(x + 3, 0), 0));
    }
    void main() {
      mat4 skin = aWeights.x * bone(aJoints.x) + aWeights.y * bone(aJoints.y)
                + aWeights.z * bone(aJoints.z) + aWeights.w * bone(aJoints.w);
      gl_Position = uProjection * uModelView * skin * vec4(aPosition, 1.0);
      vUv = aUv;
      vNormal = mat3(skin) * aNormal;
    }`,
  fragment: `#version 300 es
    precision highp float;
    uniform sampler2D uBase;
    uniform float uHasBase;
    uniform mat3 uNormalToWorld;
    uniform vec3 uAmbientCube[6];         // +x, -x, +y, -y, +z, -z
    uniform vec3 uLightDirection[4];      // world space, toward each light
    uniform vec3 uLightColor[4];
    in vec2 vUv;
    in vec3 vNormal;
    out vec4 outColor;
    void main() {
      vec3 base = uHasBase > 0.5 ? texture(uBase, vUv).rgb : vec3(0.5);
      vec3 n = normalize(uNormalToWorld * vNormal);
      vec3 sq = n * n;
      vec3 light = sq.x * uAmbientCube[n.x >= 0.0 ? 0 : 1]
                 + sq.y * uAmbientCube[n.y >= 0.0 ? 2 : 3]
                 + sq.z * uAmbientCube[n.z >= 0.0 ? 4 : 5];
      for (int i = 0; i < 4; i++) {
        float len = length(uLightDirection[i]);
        if (len < 1e-4) continue;
        float wrap = dot(n, uLightDirection[i] / len) * 0.5 + 0.5;
        light += uLightColor[i] * wrap * wrap;
      }
      outColor = vec4(base * min(pow(light, vec3(1.0 / 2.2)), vec3(2.0)), 1.0);
    }`,
};

/**
 * Bullet impacts: small quads laid on the surface that was hit. On the
 * glowing course they are hot sparks that cool down (added like the rest of
 * the course); on maps they are dark bullet holes blended over the surface.
 */
export const IMPACT_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uViewProjection;
    in vec3 aPosition;
    in vec2 aUv;
    in float aBirth;
    in float aKind;
    out vec2 vUv;
    out float vBirth;
    out float vKind;
    void main() {
      gl_Position = uViewProjection * vec4(aPosition, 1.0);
      vUv = aUv;
      vBirth = aBirth;
      vKind = aKind;
    }`,
  fragment: `#version 300 es
    precision highp float;
    uniform float uTime;
    uniform float uGlow;
    in vec2 vUv;
    in float vBirth;
    in float vKind;
    out vec4 outColor;
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r = length(p);
      if (r > 1.0) discard;
      float age = uTime - vBirth;
      if (vKind > 0.5) {
        // Blood: a ragged splat with droplets around it, seeded by its birth time.
        float a = atan(p.y, p.x);
        float seed = fract(vBirth * 7.13) * 40.0;
        float edge = 0.42 + 0.12 * sin(a * 5.0 + seed) + 0.08 * sin(a * 11.0 + seed * 1.7) + 0.05 * sin(a * 23.0 + seed * 0.3);
        float drops = step(0.93, fract(sin(dot(floor(p * 9.0), vec2(12.9898, 78.233)) + seed) * 43758.5453)) * step(r, 0.95);
        float body = smoothstep(edge + 0.04, edge - 0.04, r);
        float alpha = max(body, drops) * 0.88;
        if (alpha < 0.01) discard;
        outColor = vec4(mix(vec3(0.28, 0.01, 0.01), vec3(0.42, 0.03, 0.02), smoothstep(edge, 0.0, r)), alpha);
      } else if (uGlow > 0.5) {
        float heat = 0.35 + 2.5 * exp(-age * 6.0);
        outColor = vec4(vec3(1.0, 0.7, 0.35) * smoothstep(1.0, 0.0, r) * heat * exp(-age * 0.3), 1.0);
      } else {
        float hole = smoothstep(0.5, 0.3, r);
        float scorch = smoothstep(1.0, 0.3, r) * 0.5;
        outColor = vec4(vec3(0.03, 0.025, 0.02), max(hole * 0.95, scorch));
      }
    }`,
};

/**
 * Paints a weapon finish into a weapon's color texture, in texture
 * space: one full-screen triangle, one pass, when the finish is chosen.
 * Finish styles:
 *   0 solid color, 1 hydrographic, 2 spray paint, 3 anodized,
 *   4 anodized multicolored, 5 anodized airbrushed, 6 custom paint job,
 *   7 patina, 8 gunsmith.
 * Colors follow the finish rules: color 0 is the base coat and colors
 * 1-3 the red, green and blue layers of the pattern; solid color uses the
 * weapon's paint-by-number masks instead, anodized paints where the mask is
 * red, and patterned styles keep the masks' green and blue areas in solid
 * colors 2 and 3. On knives those areas are the handle, which stays as it is. Spray styles project the pattern
 * from the side using the weapon's position map; the others lay it on the
 * UVs. Wear strips paint where the wear texture is weaker than the wear
 * amount, first on exposed edges, and adds grime.
 */
export const FINISH_SHADER = {
  vertex: `#version 300 es
    out vec2 vUv;
    void main() {
      vec2 corner = vec2(gl_VertexID == 1 ? 2.0 : 0.0, gl_VertexID == 2 ? 2.0 : 0.0);
      vUv = corner;
      gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
    }`,
  fragment: `#version 300 es
    precision highp float;
    uniform sampler2D uColor;      // the weapon's own color texture
    uniform sampler2D uMasks;      // paint-by-number masks
    uniform sampler2D uCavity;     // r: ambient occlusion
    uniform sampler2D uPosition;   // object position over the weapon's length: g along, b up
    uniform sampler2D uPattern;
    uniform sampler2D uWearTexture;
    uniform sampler2D uGrunge;
    uniform sampler2D uRamp;       // case hardening colors
    uniform int uStyle;
    uniform vec3 uColors[4];
    uniform mat2 uPatternBasis;    // rotation and scale of the pattern
    uniform vec2 uPatternOffset;
    uniform bool uProjected;
    uniform bool uPlacedMasks;     // a finish's own masks are a pattern, placed like one
    uniform bool uHasRamp;
    uniform bool uKnife;           // knives keep their own handles
    uniform vec3 uCaseHardening;   // pattern influence, geometric influence, ramp offset
    uniform float uWearAmount;
    uniform vec2 uWearOffset;
    in vec2 vUv;
    out vec4 outColor;

    float luminance(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    vec3 byMasks(vec3 masks) {
      vec3 c = mix(uColors[0], uColors[1], masks.r);
      c = mix(c, uColors[2], masks.g);
      return mix(c, uColors[3], masks.b);
    }

    // Patterned styles keep the paint-by-number green and blue areas in solid colors 2 and 3.
    vec3 solidAreas(vec3 c, vec3 masks) {
      return mix(mix(c, uColors[2], masks.g), uColors[3], masks.b);
    }

    void main() {
      vec3 original = texture(uColor, vUv).rgb;
      float occlusion = texture(uCavity, vUv).r;
      vec3 position = texture(uPosition, vUv).rgb;
      vec2 source = uProjected ? position.gb : vUv;
      vec2 placed = uPatternBasis * source + uPatternOffset;
      vec4 pattern = texture(uPattern, placed);
      vec3 masks = texture(uMasks, uPlacedMasks ? placed : vUv).rgb;
      float metal = luminance(original);

      vec3 paint;
      float durability = 1.0;   // how much harder than paint the finish is to wear off
      vec3 bare = vec3(0.12 + metal * 0.8);
      if (uStyle == 0) {
        paint = byMasks(masks);
      } else if (uStyle == 1 || uStyle == 2) {
        paint = solidAreas(byMasks(pattern.rgb), masks);
      } else if (uStyle == 3) {
        paint = mix(original, uColors[0] * (0.4 + metal * 1.2), masks.r);
        durability = 2.0;
      } else if (uStyle == 4 || uStyle == 5) {
        paint = solidAreas(byMasks(pattern.rgb), masks) * (0.65 + metal * 0.7);
        durability = 2.0;
      } else if (uStyle == 7) {
        paint = pattern.rgb * uColors[1];
        bare = uColors[2] * (0.5 + metal);
        durability = 1.5;
      } else {
        paint = pattern.rgb;
        if (uStyle == 8) bare = uColors[0] * (0.4 + metal);
      }
      if (uHasRamp) {
        float t = pattern.r * uCaseHardening.x + position.g * uCaseHardening.y + uCaseHardening.z;
        paint = texture(uRamp, vec2(clamp(t, 0.01, 0.99), 0.5)).rgb;
      }

      // The pattern's alpha masks the finish (styles that read it): around 196
      // leaves the weapon unpainted, as on most knife handles; below 128 the
      // paint is harder to wear off; 128 and 255 change nothing.
      float alpha = pattern.a * 255.0;
      bool readsAlpha = uStyle == 1 || uStyle == 4 || uStyle == 6 || uStyle == 8;
      float unpainted = readsAlpha ? smoothstep(150.0, 170.0, alpha) * (1.0 - smoothstep(220.0, 240.0, alpha)) : 0.0;
      // A knife's paint-by-number green and blue areas are its handle and fittings:
      // only finishes painted from a full image (custom, patina, gunsmith) cover them.
      if (uKnife && uStyle < 6) unpainted = max(unpainted, max(masks.g, masks.b));
      if (readsAlpha && alpha < 127.5) durability *= 1.0 + (128.0 - alpha) / 32.0;

      // Paint holds in crevices (dark ambient occlusion) and comes off edges first.
      float strength = texture(uWearTexture, vUv * 1.6 + uWearOffset).r * mix(1.6, 0.8, occlusion) * durability;
      float removed = 1.0 - smoothstep(-0.02, 0.02, strength - uWearAmount * 1.4);
      vec3 color = mix(paint, bare, removed * step(0.001, uWearAmount));
      vec3 grime = texture(uGrunge, vUv * 1.6 + uWearOffset.yx).rgb;
      color = mix(color, color * grime * 1.6, clamp(uWearAmount * 1.3, 0.0, 1.0) * 0.5);
      color *= mix(1.0, occlusion, 0.35);
      outColor = vec4(mix(color, original, unpainted), 1.0);
    }`,
};

/**
 * Paints a glove finish: the layer mask's red,
 * green and blue (or none) pick one of four materials, each modulated by
 * its detail texture (leather grain, weave, rubber); the mask's alpha picks
 * one of eight color tints (alpha 32 = tint 1 ... 255 = tint 8). Texels of
 * the pattern's tint take the pattern instead, its red, green, blue and
 * black mixing the palette's tints.
 */
export const GLOVE_SHADER = {
  vertex: FINISH_SHADER.vertex,
  fragment: `#version 300 es
    precision highp float;
    uniform sampler2D uColor;
    uniform sampler2D uMask;
    uniform sampler2D uSurface;    // r: ambient occlusion
    uniform sampler2D uPattern;
    uniform sampler2D uDetail0;
    uniform sampler2D uDetail1;
    uniform sampler2D uDetail2;
    uniform sampler2D uDetail3;
    uniform vec3 uTints[8];
    uniform vec4 uPalette;         // tint numbers (1-8) for the pattern's red, green, blue and black
    uniform float uReplaceIndex;   // tint number the pattern replaces
    uniform bool uHasPattern;
    uniform mat2 uPatternBasis;
    uniform vec4 uDetailScale;
    uniform vec4 uHasDetail;
    uniform float uWearAmount;
    in vec2 vUv;
    out vec4 outColor;

    vec3 tint(float number) {
      int i = clamp(int(number + 0.5) - 1, 0, 7);
      return uTints[i];
    }

    float detail(sampler2D map, float scale, float used) {
      return used > 0.5 ? dot(texture(map, vUv * scale).rgb, vec3(0.333)) * 2.0 : 1.0;
    }

    void main() {
      vec4 mask = texture(uMask, vUv);
      float number = mask.a * 255.0 / 32.0;
      vec3 color = tint(number);
      if (uHasPattern && abs(number - uReplaceIndex) < 0.5) {
        vec4 p = texture(uPattern, uPatternBasis * vUv);
        color = tint(uPalette.w);
        color = mix(color, tint(uPalette.x), p.r);
        color = mix(color, tint(uPalette.y), p.g);
        color = mix(color, tint(uPalette.z), p.b);
      }
      float none = clamp(1.0 - mask.r - mask.g - mask.b, 0.0, 1.0);
      float grain = detail(uDetail0, uDetailScale.x, uHasDetail.x) * none
        + detail(uDetail1, uDetailScale.y, uHasDetail.y) * mask.r
        + detail(uDetail2, uDetailScale.z, uHasDetail.z) * mask.g
        + detail(uDetail3, uDetailScale.w, uHasDetail.w) * mask.b;
      float occlusion = texture(uSurface, vUv).r;
      color *= mix(1.0, grain, 0.6) * mix(1.0, occlusion, 0.6);
      color = mix(color, color * 0.75 + 0.06, uWearAmount * 0.6);   // worn gloves fade and dull
      outColor = vec4(color, 1.0);
    }`,
};

/**
 * The 1v1 arena: flat-colored, sunlit boxes with a faint 64-unit grid, like
 * a developer texture, fading into the space backdrop with distance.
 */
export const ARENA_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uViewProjection;
    in vec3 aPosition;
    in vec3 aNormal;
    in vec3 aColor;
    out vec3 vWorld;
    out vec3 vNormal;
    out vec3 vColor;
    void main() {
      gl_Position = uViewProjection * vec4(aPosition, 1.0);
      vWorld = aPosition;
      vNormal = aNormal;
      vColor = aColor;
    }`,
  fragment: `#version 300 es
    precision highp float;
    uniform vec3 uEye;
    uniform vec3 uSun;
    in vec3 vWorld;
    in vec3 vNormal;
    in vec3 vColor;
    out vec4 outColor;
    float gridLine(vec2 p, float size) {
      vec2 cell = abs(fract(p / size - 0.5) - 0.5) * size;
      vec2 width = fwidth(p) * 1.2;
      vec2 line = 1.0 - smoothstep(vec2(0.0), width, cell);
      return max(line.x, line.y);
    }
    void main() {
      vec3 n = normalize(vNormal);
      vec2 plane = abs(n.z) > 0.5 ? vWorld.xy : (abs(n.x) > 0.5 ? vWorld.yz : vWorld.xz);
      float grid = max(gridLine(plane, 64.0) * 0.35, gridLine(plane, 256.0) * 0.6);
      float light = 0.38 + 0.62 * max(dot(n, uSun), 0.0) + 0.08 * n.z;
      vec3 color = vColor * light * (1.0 - grid * 0.25);
      float fade = smoothstep(2500.0, 6000.0, distance(vWorld, uEye));
      outColor = vec4(mix(color, vec3(0.02, 0.025, 0.06), fade), 1.0);
    }`,
};

/**
 * Muzzle flash: a camera-facing quad at the muzzle drawn additively, a hot
 * core with a few soft spikes, turned at random each shot.
 */
export const MUZZLE_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uProjection;
    uniform mat4 uModelView;
    uniform vec3 uCenter;
    uniform float uSize;           // half width, in eye-space units
    uniform vec2 uScale;           // the projection's x and y scale
    out vec2 vCorner;
    void main() {
      vec2 corners[6] = vec2[6](vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, -1), vec2(1, 1), vec2(-1, 1));
      vCorner = corners[gl_VertexID];
      gl_Position = uProjection * uModelView * vec4(uCenter, 1.0);
      gl_Position.xy += vCorner * uSize * uScale;
    }`,
  fragment: `#version 300 es
    precision highp float;
    uniform float uRotation;
    uniform float uIntensity;
    in vec2 vCorner;
    out vec4 outColor;
    void main() {
      float r = length(vCorner);
      float angle = atan(vCorner.y, vCorner.x) + uRotation;
      float spikes = pow(abs(cos(angle * 2.5)), 6.0) * (1.0 - r);
      float core = exp(-r * r * 9.0);
      float glow = exp(-r * 3.0) * 0.35;
      float light = (core + spikes * 0.9 + glow) * uIntensity;
      outColor = vec4(vec3(1.0, 0.78, 0.42) * light + vec3(1.0) * core * core * uIntensity * 0.6, 1.0);
    }`,
};

/** A bullet tracer: a thin streak, brightest at its head and along its middle. */
export const TRACER_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uViewProjection;
    in vec3 aPosition;
    in vec2 aUv;
    out vec2 vUv;
    void main() {
      gl_Position = uViewProjection * vec4(aPosition, 1.0);
      vUv = aUv;
    }`,
  fragment: `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 outColor;
    void main() {
      float across = 1.0 - abs(vUv.y);
      float along = vUv.x;
      vec3 color = vec3(1.0, 0.75, 0.38) * across * along * 3.0 + vec3(1.0) * pow(across, 4.0) * along * 1.5;
      outColor = vec4(color, 1.0);
    }`,
};

/** Blood particles: soft round drops, dark red, fading out. */
export const BLOOD_SHADER = {
  vertex: `#version 300 es
    uniform mat4 uViewProjection;
    in vec3 aPosition;
    in vec2 aCorner;
    in float aFade;
    out vec2 vCorner;
    out float vFade;
    void main() {
      gl_Position = uViewProjection * vec4(aPosition, 1.0);
      vCorner = aCorner;
      vFade = aFade;
    }`,
  fragment: `#version 300 es
    precision highp float;
    in vec2 vCorner;
    in float vFade;
    out vec4 outColor;
    void main() {
      float r = length(vCorner);
      if (r > 1.0) discard;
      outColor = vec4(0.38, 0.02, 0.02, smoothstep(1.0, 0.4, r) * vFade);
    }`,
};
