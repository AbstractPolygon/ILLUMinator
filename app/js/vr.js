// View in VR: a stereo pair on a large virtual screen in a VR headset,
// through WebXR (the Meta Quest Browser and other headset browsers). Each
// eye sees its own picture on the same screen, so the scene stands out in
// depth like a 3D film. Press a controller trigger (or the headset's own
// exit) to leave.

const SCREEN_WIDTH = 2.4; // meters
const SCREEN_DISTANCE = 2.2; // meters in front of where the head starts

export async function vrSupported() {
  try {
    return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr')));
  } catch {
    return false;
  }
}

const VERTEX = `#version 300 es
in vec2 aPos;
uniform mat4 uProj;
uniform mat4 uView;
uniform vec2 uHalf;     // half the screen's width and height, meters
uniform float uDist;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = uProj * uView * vec4(aPos * uHalf, -uDist, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uTex, vUv).rgb, 1.0);
}`;

function program(gl) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function texture(gl, source) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// Shows `left` and `right` (canvases or images of one size) until the
// viewer leaves VR. Resolves when the session ends.
export async function showInVr(left, right) {
  if (!navigator.xr) throw new Error('This browser cannot show VR.');
  const session = await navigator.xr.requestSession('immersive-vr');
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { xrCompatible: true, antialias: true });
  if (!gl) {
    await session.end();
    throw new Error('VR needs WebGL 2.');
  }
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  const space = await session.requestReferenceSpace('local');

  const prog = program(gl);
  const u = Object.fromEntries(['uProj', 'uView', 'uHalf', 'uDist', 'uTex'].map((n) => [n, gl.getUniformLocation(prog, n)]));
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const tex = { left: texture(gl, left), right: texture(gl, right) };
  const half = [SCREEN_WIDTH / 2, (SCREEN_WIDTH / 2) * (left.height / left.width)];

  // A trigger press leaves VR.
  session.addEventListener('select', () => session.end());
  const ended = new Promise((resolve) => session.addEventListener('end', resolve));

  const draw = (time, frame) => {
    const layer = session.renderState.baseLayer;
    const pose = frame.getViewerPose(space);
    session.requestAnimationFrame(draw);
    if (!pose) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0.06, 0.06, 0.07, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniform2f(u.uHalf, half[0], half[1]);
    gl.uniform1f(u.uDist, SCREEN_DISTANCE);
    gl.uniform1i(u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const view of pose.views) {
      const vp = layer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      gl.uniformMatrix4fv(u.uProj, false, view.projectionMatrix);
      gl.uniformMatrix4fv(u.uView, false, view.transform.inverse.matrix);
      gl.bindTexture(gl.TEXTURE_2D, view.eye === 'right' ? tex.right : tex.left);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  };
  session.requestAnimationFrame(draw);
  await ended;
  gl.deleteTexture(tex.left);
  gl.deleteTexture(tex.right);
}
