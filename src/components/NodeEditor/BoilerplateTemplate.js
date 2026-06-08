export const GLSL_BOILERPLATE = `#version 300 es
precision highp float;

// Incoming UV coordinates
in vec2 v_uv;

// Input texture (the connected image source)
uniform sampler2D u_texture;

// Resolution of the target
uniform vec2 u_resolution;

// Current playback time in seconds
uniform float u_time;

// You can define custom parameters that will appear in the Inspector!
// Syntax: // @param name="Label Name" min=0.0 max=1.0 default=0.5 step=0.01
// @param name="Intensity" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_intensity;

// Output color
out vec4 fragColor;

void main() {
  // 1. Read the input texture
  vec4 col = texture(u_texture, v_uv);
  
  // 2. Modify the color
  vec3 modified = col.rgb * vec3(1.0, 0.8, 0.6); // Warm tint
  
  // 3. Mix based on the intensity parameter
  col.rgb = mix(col.rgb, modified, u_intensity);
  
  // 4. Output the final color
  fragColor = col;
}
`
