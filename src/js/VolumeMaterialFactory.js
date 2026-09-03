import * as THREE from 'three';
import {
	volumeVertexShader,
	volumeFragmentShader,
	SHADER_DEFAULTS,
	RENDER_MODES
} from './VolumeShaders.js';

/**
 * Colormap definitions
 * Each colormap is an array of [position, r, g, b] control points
 */
const COLORMAP_DATA = {
	grayscale: [
		[0.0, 0, 0, 0],
		[1.0, 255, 255, 255]
	],
	viridis: [
		[0.0, 68, 1, 84],
		[0.25, 59, 82, 139],
		[0.5, 33, 145, 140],
		[0.75, 94, 201, 98],
		[1.0, 253, 231, 37]
	],
	hot: [
		[0.0, 0, 0, 0],
		[0.33, 230, 0, 0],
		[0.66, 255, 210, 0],
		[1.0, 255, 255, 255]
	],
	bone: [
		[0.0, 0, 0, 0],
		[0.33, 57, 57, 86],
		[0.66, 119, 154, 171],
		[1.0, 255, 255, 255]
	],
	cool: [
		[0.0, 0, 255, 255],
		[1.0, 255, 0, 255]
	],
	plasma: [
		[0.0, 13, 8, 135],
		[0.25, 126, 3, 168],
		[0.5, 204, 71, 120],
		[0.75, 248, 149, 64],
		[1.0, 240, 249, 33]
	]
};

/**
 * Generate a colormap texture from control points
 * @param {Array} controlPoints - Array of [position, r, g, b] control points
 * @param {number} width - Texture width (default 256)
 * @returns {THREE.DataTexture}
 */
function generateColormapTexture(controlPoints, width = 256) {
	const data = new Uint8Array(width * 4);

	for (let i = 0; i < width; i++) {
		const t = i / (width - 1);

		// Find surrounding control points
		let lower = controlPoints[0];
		let upper = controlPoints[controlPoints.length - 1];

		for (let j = 0; j < controlPoints.length - 1; j++) {
			if (t >= controlPoints[j][0] && t <= controlPoints[j + 1][0]) {
				lower = controlPoints[j];
				upper = controlPoints[j + 1];
				break;
			}
		}

		// Interpolate
		const range = upper[0] - lower[0];
		const localT = range > 0 ? (t - lower[0]) / range : 0;

		const idx = i * 4;
		data[idx] = Math.round(lower[1] + localT * (upper[1] - lower[1]));
		data[idx + 1] = Math.round(lower[2] + localT * (upper[2] - lower[2]));
		data[idx + 2] = Math.round(lower[3] + localT * (upper[3] - lower[3]));
		data[idx + 3] = 255;
	}

	const texture = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
	texture.needsUpdate = true;
	texture.minFilter = THREE.LinearFilter;
	texture.magFilter = THREE.LinearFilter;
	texture.wrapS = THREE.ClampToEdgeWrapping;
	texture.wrapT = THREE.ClampToEdgeWrapping;

	return texture;
}

/**
 * VolumeMaterialFactory - Creates and manages volume rendering materials
 */
export default class VolumeMaterialFactory {
	constructor() {
		this.colormapTextures = new Map();
		this._initColormaps();
	}

	/**
	 * Initialize all colormap textures
	 * @private
	 */
	_initColormaps() {
		for (const [name, data] of Object.entries(COLORMAP_DATA)) {
			this.colormapTextures.set(name, generateColormapTexture(data));
		}
	}

	/**
	 * Get available colormap names
	 * @returns {string[]}
	 */
	getColormapNames() {
		return Array.from(this.colormapTextures.keys());
	}

	/**
	 * Get a colormap texture by name
	 * @param {string} name - Colormap name
	 * @returns {THREE.DataTexture}
	 */
	getColormapTexture(name) {
		return this.colormapTextures.get(name) || this.colormapTextures.get('grayscale');
	}

	/**
	 * Create a volume rendering material
	 * @param {THREE.Data3DTexture} volumeTexture - The 3D volume texture
	 * @param {Object} options - Material options
	 * @param {string} options.colormap - Colormap name (default: 'grayscale')
	 * @param {number} options.threshold - Visibility threshold 0-1 (default: 0.1)
	 * @param {number} options.opacity - Global opacity 0-1 (default: 1.0)
	 * @param {number} options.stepCount - Ray marching steps (default: 256)
	 * @param {string} options.renderMode - 'mip' or 'opacity' (default: 'mip')
	 * @returns {THREE.ShaderMaterial}
	 */
	createMaterial(volumeTexture, options = {}) {
		const colormap = options.colormap || 'grayscale';
		const threshold = options.threshold ?? SHADER_DEFAULTS.threshold;
		const opacity = options.opacity ?? SHADER_DEFAULTS.opacity;
		const stepCount = options.stepCount ?? SHADER_DEFAULTS.stepCount;
		const renderMode = options.renderMode === 'opacity' ? RENDER_MODES.OPACITY : RENDER_MODES.MIP;

		const colormapTexture = this.getColormapTexture(colormap);

		const material = new THREE.ShaderMaterial({
			uniforms: {
				uVolume: { value: volumeTexture },
				uColormap: { value: colormapTexture },
				uVolumeSize: {
					value: new THREE.Vector3(
						volumeTexture.image.width,
						volumeTexture.image.height,
						volumeTexture.image.depth
					)
				},
				uThreshold: { value: threshold },
				uOpacity: { value: opacity },
				uStepCount: { value: stepCount },
				uRenderMode: { value: renderMode },
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

		if (updates.colormap !== undefined) {
			material.uniforms.uColormap.value = this.getColormapTexture(updates.colormap);
		}

		if (updates.threshold !== undefined) {
			material.uniforms.uThreshold.value = updates.threshold;
		}

		if (updates.opacity !== undefined) {
			material.uniforms.uOpacity.value = updates.opacity;
		}

		if (updates.stepCount !== undefined) {
			material.uniforms.uStepCount.value = updates.stepCount;
		}

		if (updates.renderMode !== undefined) {
			material.uniforms.uRenderMode.value =
				updates.renderMode === 'opacity' ? RENDER_MODES.OPACITY : RENDER_MODES.MIP;
		}

		// Update jitter each frame for temporal anti-aliasing
		if (updates.updateJitter) {
			material.uniforms.uJitterOffset.value = Math.random();
		}
	}

	/**
	 * Dispose of all colormap textures
	 */
	dispose() {
		for (const texture of this.colormapTextures.values()) {
			texture.dispose();
		}
		this.colormapTextures.clear();
	}
}

// Export render mode constants
export { RENDER_MODES };
