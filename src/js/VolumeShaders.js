/**
 * VolumeShaders.js - GLSL shaders for volume rendering
 *
 * Supports two rendering modes:
 * - MIP (Maximum Intensity Projection): Track maximum value along ray
 * - Opacity: Front-to-back compositing with early termination
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
uniform sampler2D uColormap;
uniform vec3 uVolumeSize;
uniform float uContrastMin;
uniform float uContrastMax;
uniform float uOpacity;
uniform int uStepCount;
uniform int uRenderMode; // 0 = MIP, 1 = Opacity
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

// Map raw intensity into [0,1] using the contrast limits (values above max saturate)
float applyContrast(float value) {
	return clamp((value - uContrastMin) / max(uContrastMax - uContrastMin, 1e-5), 0.0, 1.0);
}

// Apply colormap lookup
vec3 applyColormap(float value) {
	return texture(uColormap, vec2(value, 0.5)).rgb;
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

	if (uRenderMode == 0) {
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

		vec3 color = applyColormap(applyContrast(maxIntensity));
		gl_FragColor = vec4(color, uOpacity);

	} else {
		// Opacity-based front-to-back compositing
		vec4 accumulatedColor = vec4(0.0);
		vec3 pos = rayStart;

		for (int i = 0; i < 512; i++) {
			if (i >= uStepCount) break;

			float t = tStart + float(i) * stepSize;
			if (t >= bounds.y) break;

			float intensity = sampleVolume(pos);

			if (intensity > uContrastMin) {
				// Map contrast-normalized intensity to opacity
				float normalized = applyContrast(intensity);
				float alpha = normalized * uOpacity * 0.5; // Scale down for accumulation

				vec3 color = applyColormap(normalized);

				// Front-to-back compositing
				accumulatedColor.rgb += (1.0 - accumulatedColor.a) * alpha * color;
				accumulatedColor.a += (1.0 - accumulatedColor.a) * alpha;

				// Early termination when nearly opaque
				if (accumulatedColor.a >= 0.95) {
					break;
				}
			}

			pos += rayStep;
		}

		if (accumulatedColor.a < 0.01) {
			discard;
		}

		gl_FragColor = accumulatedColor;
	}
}
`;

/**
 * Shader configuration defaults
 */
export const SHADER_DEFAULTS = {
	stepCount: 256,
	contrastMin: 0.1,
	contrastMax: 1.0,
	opacity: 1.0,
	renderMode: 0 // MIP
};

/**
 * Render mode constants
 */
export const RENDER_MODES = {
	MIP: 0,
	OPACITY: 1
};
