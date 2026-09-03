/**
 * VolumeShaders.js - GLSL shaders for volume rendering
 *
 * Maximum Intensity Projection (MIP): track the maximum value along each ray,
 * then apply contrast limits and gamma before writing a grayscale color.
 */

export const volumeVertexShader = /* glsl */`
varying vec3 vOrigin;
varying vec3 vDirection;

void main() {
	vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
	vOrigin = vec3(inverse(modelMatrix) * vec4(cameraPosition, 1.0));
	vDirection = position - vOrigin;
	gl_Position = projectionMatrix * mvPosition;
}
`;

export const volumeFragmentShader = /* glsl */`
precision highp float;
precision highp int;

uniform highp sampler3D uVolume;
uniform vec3 uVolumeSize;
uniform float uContrastMin;
uniform float uContrastMax;
uniform float uGamma;
uniform int uStepCount;
uniform float uJitterOffset;

varying vec3 vOrigin;
varying vec3 vDirection;

// Ray-box intersection using slab method
vec2 intersectBox(vec3 origin, vec3 direction) {
	vec3 invDir = 1.0 / direction;
	vec3 tMin = (vec3(0.0) - origin) * invDir;
	vec3 tMax = (vec3(1.0) - origin) * invDir;
	vec3 t1 = min(tMin, tMax);
	vec3 t2 = max(tMin, tMax);
	float tNear = max(max(t1.x, t1.y), t1.z);
	float tFar = min(min(t2.x, t2.y), t2.z);
	return vec2(tNear, tFar);
}

// Sample volume with trilinear interpolation
float sampleVolume(vec3 pos) {
	// Clamp to valid range with small epsilon
	vec3 clampedPos = clamp(pos, 0.001, 0.999);
	return texture(uVolume, clampedPos).r;
}

// Map raw intensity into [0,1] using the contrast limits (values above max saturate),
// then apply gamma (napari convention: value ^ gamma)
float applyContrastAndGamma(float value) {
	float normalized = clamp((value - uContrastMin) / max(uContrastMax - uContrastMin, 1e-5), 0.0, 1.0);
	return pow(normalized, uGamma);
}

void main() {
	vec3 rayDir = normalize(vDirection);
	vec2 bounds = intersectBox(vOrigin, rayDir);

	if (bounds.x >= bounds.y) {
		discard;
	}

	bounds.x = max(bounds.x, 0.0);

	// Calculate step size based on volume dimensions and step count
	float diagonal = length(vec3(1.0));
	float stepSize = diagonal / float(uStepCount);

	// Jitter starting position to reduce banding
	float jitter = uJitterOffset * stepSize;
	float tStart = bounds.x + jitter;

	vec3 rayStart = vOrigin + rayDir * tStart;
	vec3 rayStep = rayDir * stepSize;

	// MIP (Maximum Intensity Projection)
	float maxIntensity = 0.0;
	vec3 pos = rayStart;

	for (int i = 0; i < 512; i++) {
		if (i >= uStepCount) break;

		float t = tStart + float(i) * stepSize;
		if (t >= bounds.y) break;

		float intensity = sampleVolume(pos);

		// Voxels below the lower contrast limit are invisible
		if (intensity > uContrastMin) {
			maxIntensity = max(maxIntensity, intensity);
		}

		pos += rayStep;
	}

	if (maxIntensity <= uContrastMin) {
		discard;
	}

	float gray = applyContrastAndGamma(maxIntensity);
	gl_FragColor = vec4(vec3(gray), 1.0);
}
`;

/**
 * Shader configuration defaults
 */
export const SHADER_DEFAULTS = {
	stepCount: 512,
	contrastMin: 0.1,
	contrastMax: 1.0,
	gamma: 1.0
};
