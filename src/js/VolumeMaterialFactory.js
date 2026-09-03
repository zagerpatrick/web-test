import * as THREE from 'three';
import {
	volumeVertexShader,
	volumeFragmentShader,
	SHADER_DEFAULTS
} from './VolumeShaders.js';

/**
 * VolumeMaterialFactory - Creates and manages volume rendering materials
 *
 * Renders a grayscale Maximum Intensity Projection with adjustable contrast
 * limits and gamma.
 */
export default class VolumeMaterialFactory {
	/**
	 * Create a volume rendering material
	 * @param {THREE.Data3DTexture} volumeTexture - The 3D volume texture
	 * @param {Object} options - Material options
	 * @param {number} options.contrastMin - Lower contrast limit 0-1; voxels below are hidden (default: 0.1)
	 * @param {number} options.contrastMax - Upper contrast limit 0-1; voxels above saturate (default: 1.0)
	 * @param {number} options.gamma - Gamma exponent applied after contrast (default: 1.0)
	 * @param {number} options.stepCount - Ray marching steps (default: 512)
	 * @returns {THREE.ShaderMaterial}
	 */
	createMaterial(volumeTexture, options = {}) {
		const contrastMin = options.contrastMin ?? SHADER_DEFAULTS.contrastMin;
		const contrastMax = options.contrastMax ?? SHADER_DEFAULTS.contrastMax;
		const gamma = options.gamma ?? SHADER_DEFAULTS.gamma;
		const stepCount = options.stepCount ?? SHADER_DEFAULTS.stepCount;

		const material = new THREE.ShaderMaterial({
			uniforms: {
				uVolume: { value: volumeTexture },
				uVolumeSize: {
					value: new THREE.Vector3(
						volumeTexture.image.width,
						volumeTexture.image.height,
						volumeTexture.image.depth
					)
				},
				uContrastMin: { value: contrastMin },
				uContrastMax: { value: contrastMax },
				uGamma: { value: gamma },
				uStepCount: { value: stepCount },
				uJitterOffset: { value: Math.random() }
			},
			vertexShader: volumeVertexShader,
			fragmentShader: volumeFragmentShader,
			side: THREE.BackSide,
			transparent: true,
			depthWrite: false,
			depthTest: true
		});

		return material;
	}

	/**
	 * Update material uniforms
	 * @param {THREE.ShaderMaterial} material - The volume material
	 * @param {Object} updates - Uniform updates
	 */
	updateMaterial(material, updates) {
		if (!material || !material.uniforms) return;

		if (updates.volumeTexture !== undefined) {
			material.uniforms.uVolume.value = updates.volumeTexture;
			material.uniforms.uVolumeSize.value.set(
				updates.volumeTexture.image.width,
				updates.volumeTexture.image.height,
				updates.volumeTexture.image.depth
			);
		}

		if (updates.contrastMin !== undefined) {
			material.uniforms.uContrastMin.value = updates.contrastMin;
		}

		if (updates.contrastMax !== undefined) {
			material.uniforms.uContrastMax.value = updates.contrastMax;
		}

		if (updates.gamma !== undefined) {
			material.uniforms.uGamma.value = updates.gamma;
		}

		if (updates.stepCount !== undefined) {
			material.uniforms.uStepCount.value = updates.stepCount;
		}

		// Update jitter each frame for temporal anti-aliasing
		if (updates.updateJitter) {
			material.uniforms.uJitterOffset.value = Math.random();
		}
	}

	/**
	 * Release any GPU resources held by the factory (none at present)
	 */
	dispose() {}
}
