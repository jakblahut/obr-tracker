/**
 * SkSL shaders for the animated bar and turn ring. Owlbear provides `size`
 * (item size in pixels, coord runs 0..size from the top left) and `time`.
 * Colors are returned premultiplied.
 */

const NOISE = `
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/** HP bar: colored border, dark track, fill with drifting smoke, temp HP after it. */
export const BAR_SKSL = `
uniform vec2 size;
uniform float time;
uniform float hp;
uniform float temp;
uniform vec3 color;
${NOISE}
half4 main(float2 coord) {
  float border = max(size.y * 0.12, 1.0);
  vec2 d = min(coord, size - coord);
  if (min(d.x, d.y) < border) {
    return half4(color, 1.0);
  }
  vec2 inner = (coord - border) / (size - 2.0 * border);
  // Stretch noise to the bar's aspect so the smoke isn't squashed.
  vec2 q = vec2(inner.x * size.x / size.y, inner.y) * 1.1;
  float smoke = noise(q + vec2(-time * 0.9, time * 0.35)) * 0.6
              + noise(q * 2.0 + vec2(-time * 1.6, -time * 0.5)) * 0.4;
  if (inner.x < hp) {
    // A soft glint drifts along the filled part.
    float g = (inner.x - fract(time * 0.25) * hp) * size.x / size.y * 1.2;
    float glint = exp(-g * g);
    vec3 c = color * (0.6 + 0.6 * smoke) + vec3(0.35) * glint * (1.0 - abs(inner.y - 0.5) * 2.0);
    return half4(clamp(c, 0.0, 1.0), 1.0);
  }
  if (inner.x < temp) {
    vec3 c = vec3(0.35, 0.75, 1.0) * (0.65 + 0.5 * smoke);
    return half4(clamp(c, 0.0, 1.0), 1.0);
  }
  float a = 0.8;
  return half4(vec3(0.07) * a, a);
}
`;

/** Turn indicator: dim ring with a bright comet orbiting it. */
export const RING_SKSL = `
uniform vec2 size;
uniform float time;
uniform vec3 color;

half4 main(float2 coord) {
  const float PI = 3.14159265;
  vec2 p = coord / size * 2.0 - 1.0;
  float r = length(p);
  float radius = 0.86;
  float line = 1.0 - smoothstep(0.008, 0.025, abs(r - radius));
  float glow = 1.0 - smoothstep(0.0, 0.09, abs(r - radius));
  float a = atan(p.y, p.x);
  float head = mod(time * 2.2, 2.0 * PI) - PI;
  // 0 at the comet head, growing along the tail behind it.
  float behind = mod(head - a + 2.0 * PI, 2.0 * PI);
  float tail = 1.0 - smoothstep(0.0, PI * 1.3, behind);
  float alpha = clamp(line * (0.3 + 0.7 * tail) + glow * 0.55 * tail * tail, 0.0, 1.0);
  return half4(color * alpha, alpha);
}
`;
