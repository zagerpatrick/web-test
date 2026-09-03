import * as THREE from 'three';

/**
 * MaterialFactory - Material creation and processing utilities
 * Shared across all views to ensure consistent material appearance
 */

// Default clay material settings
const DEFAULT_CLAY_COLOR = 0xf5f0e8;
const DEFAULT_ROUGHNESS = 0.9;
const DEFAULT_METALNESS = 0.0;

/**
 * Create a matte clay/porcelain material
 * @param {Object} options - Material options
 * @param {number} options.color - Material color (hex)
 * @param {number} options.roughness - Material roughness (0-1)
 * @param {number} options.metalness - Material metalness (0-1)
 * @returns {THREE.MeshStandardMaterial}
 */
export function createClayMaterial(options = {}) {
	return new THREE.MeshStandardMaterial({
		color: new THREE.Color(options.color ?? DEFAULT_CLAY_COLOR),
		roughness: options.roughness ?? DEFAULT_ROUGHNESS,
		metalness: options.metalness ?? DEFAULT_METALNESS,
		flatShading: false,
	});
}

/**
 * Process all materials in a scene/object to use clay material
 * @param {THREE.Object3D} object - The object to process
 * @param {Object} materialOptions - Options passed to createClayMaterial
 */
export function processMaterials(object, materialOptions = {}) {
	object.traverse((child) => {
		if (child.isMesh) {
			// Ensure geometry has normals (required for lighting)
			if (child.geometry && !child.geometry.attributes.normal) {
				child.geometry.computeVertexNormals();
			}

			if (child.material) {
				const materials = Array.isArray(child.material) ? child.material : [child.material];
				const newMaterials = materials.map((mat) => {
					const clayMat = createClayMaterial(materialOptions);
					// Dispose old material
					mat.dispose();
					return clayMat;
				});

				child.material = newMaterials.length === 1 ? newMaterials[0] : newMaterials;
			}
		}
	});
}

/**
 * Process materials to use vertex colors (for labeled/colored meshes)
 * @param {THREE.Object3D} object - The object to process
 * @param {Object} options - Material options
 * @param {number} options.roughness - Material roughness (0-1)
 * @param {number} options.metalness - Material metalness (0-1)
 */
export function processVertexColorMaterials(object, options = {}) {
	object.traverse((child) => {
		if (child.isMesh) {
			// Ensure geometry has normals (required for lighting)
			if (child.geometry && !child.geometry.attributes.normal) {
				child.geometry.computeVertexNormals();
			}

			// Check if geometry has vertex colors
			const hasVertexColors = child.geometry?.attributes?.color != null;

			if (child.material) {
				const materials = Array.isArray(child.material) ? child.material : [child.material];
				const newMaterials = materials.map((mat) => {
					const newMat = new THREE.MeshStandardMaterial({
						vertexColors: hasVertexColors,
						roughness: options.roughness ?? DEFAULT_ROUGHNESS,
						metalness: options.metalness ?? DEFAULT_METALNESS,
						flatShading: true, // Use flat shading for per-face colors
					});
					// Dispose old material
					mat.dispose();
					return newMat;
				});

				child.material = newMaterials.length === 1 ? newMaterials[0] : newMaterials;
			}
		}
	});
}

/**
 * Create standard lighting setup for a scene
 * @param {THREE.Scene} scene - Scene to add lights to
 * @param {THREE.Camera} camera - Camera to attach camera light to
 */
export function createLightingSetup(scene, camera) {
	// Hemisphere light for even base illumination (sky/ground)
	const hemiLight = new THREE.HemisphereLight(0xffffff, 0x888888, 0.3);
	scene.add(hemiLight);

	// Ambient for additional fill
	const ambientLight = new THREE.AmbientLight(0xffffff, 0.15);
	scene.add(ambientLight);

	// Key light - main light from upper front
	const keyLight = new THREE.DirectionalLight(0xffffff, 0.35);
	keyLight.position.set(50, 200, 100);
	scene.add(keyLight);

	// Fill light - from opposite side
	const fillLight = new THREE.DirectionalLight(0xffffff, 0.25);
	fillLight.position.set(-100, 150, 100);
	scene.add(fillLight);

	// Back light - subtle, for depth
	const backLight = new THREE.DirectionalLight(0xffffff, 0.15);
	backLight.position.set(0, 100, -150);
	scene.add(backLight);

	// Camera-following light - attached to camera so it always illuminates from view direction
	const cameraLight = new THREE.DirectionalLight(0xffffff, 3);
	cameraLight.position.set(0, 0, 1); // In front of camera
	camera.add(cameraLight);
	scene.add(camera);

	return { hemiLight, ambientLight, keyLight, fillLight, backLight, cameraLight };
}
