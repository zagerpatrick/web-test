import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import sharedRenderer from './SharedRenderer.js';
import { processMaterials, processVertexColorMaterials, createLightingSetup } from './MaterialFactory.js';
import OrientationMarker from './OrientationMarker.js';

/**
 * MeshTimeseriesView - Encapsulates a single mesh timeseries view
 *
 * Each view has its own:
 * - Scene with lighting
 * - Camera with TrackballControls
 * - Meshes array for the timeseries
 * - Independent playback state
 */
export default class MeshTimeseriesView {
	/**
	 * Create a new mesh timeseries view
	 * @param {Object} options - View configuration
	 * @param {HTMLElement} options.elem - DOM element to render into
	 * @param {string} options.basePath - Base path for mesh files (e.g., 'public/dataset1/mesh')
	 * @param {number} options.meshCount - Number of meshes in the timeseries
	 * @param {string} options.fileExtension - File extension (default: '.glb')
	 * @param {number} options.loadConcurrency - Concurrent loads (default: 12)
	 * @param {number} options.defaultPlaySpeed - Default playback speed in ms (default: 250)
	 * @param {boolean} options.enableControls - Enable OrbitControls (default: true)
	 * @param {boolean} options.useVertexColors - Use vertex colors from mesh (default: false)
	 * @param {Function} options.onLoadProgress - Callback for load progress (loaded, total)
	 * @param {Function} options.onLoadComplete - Callback when all meshes loaded
	 * @param {Function} options.onFrameChange - Callback when frame changes (index)
	 */
	constructor(options) {
		this.elem = options.elem;
		this.basePath = options.basePath;
		this.meshCount = options.meshCount || 90;
		this.fileExtension = options.fileExtension || '.glb';
		this.loadConcurrency = options.loadConcurrency || 12;
		this.defaultPlaySpeed = options.defaultPlaySpeed || 250;
		this.enableControls = options.enableControls !== false;
		this.useVertexColors = options.useVertexColors || false;

		// Callbacks
		this.onLoadProgress = options.onLoadProgress || (() => {});
		this.onLoadComplete = options.onLoadComplete || (() => {});
		this.onFrameChange = options.onFrameChange || (() => {});

		// State
		this.meshes = new Array(this.meshCount);
		this.currentIndex = 0;
		this.isPlaying = false;
		this.playTimeoutId = null;
		this.playSpeed = this.defaultPlaySpeed;
		this.loadedCount = 0;
		this.isDisposed = false;

		// Three.js objects
		this.scene = null;
		this.camera = null;
		this.controls = null;
		this.lights = null;
		this.orientationMarker = null;

		this._init();
	}

	/**
	 * Initialize the view
	 * @private
	 */
	_init() {
		// Create scene
		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0xd0d0d0);

		// Create camera
		this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
		this.camera.position.set(150, 150, 150);

		// Create lighting
		this.lights = createLightingSetup(this.scene, this.camera);

		// Create controls (scoped to the view element)
		if (this.enableControls) {
			// TrackballControls allow free rotation in any direction
			this.controls = new TrackballControls(this.camera, this.elem);
			this.controls.rotateSpeed = 2.0;
			this.controls.zoomSpeed = 1.2;
			this.controls.panSpeed = 0.8;
			this.controls.staticMoving = false;
			this.controls.dynamicDampingFactor = 0.6;
		}

		// Create orientation marker
		this.orientationMarker = new OrientationMarker();

		// Register with shared renderer
		sharedRenderer.addView(this);

		// Start loading meshes
		this._loadAllMeshes();
	}

	/**
	 * Generate file URLs for all meshes
	 * @private
	 * @returns {string[]}
	 */
	_generateFileUrls() {
		const urls = [];
		for (let i = 1; i <= this.meshCount; i++) {
			const padded = String(i).padStart(4, '0');
			urls.push(`${this.basePath}${padded}${this.fileExtension}`);
		}
		return urls;
	}

	/**
	 * Load all meshes with concurrency control
	 * @private
	 */
	_loadAllMeshes() {
		const urls = this._generateFileUrls();
		const loader = sharedRenderer.getLoader();

		let activeLoads = 0;
		let nextIndex = 0;
		let firstFrameShown = false;

		const loadNext = () => {
			if (this.isDisposed) return;

			while (activeLoads < this.loadConcurrency && nextIndex < urls.length) {
				const index = nextIndex++;
				activeLoads++;

				loader.loadAsync(urls[index])
					.then((gltf) => {
						if (this.isDisposed) {
							// Dispose if view was destroyed during loading
							gltf.scene.traverse((child) => {
								if (child.geometry) child.geometry.dispose();
								if (child.material) {
									if (Array.isArray(child.material)) {
										child.material.forEach(m => m.dispose());
									} else {
										child.material.dispose();
									}
								}
							});
							return;
						}

						gltf.scene.visible = false;
						if (this.useVertexColors) {
							processVertexColorMaterials(gltf.scene);
						} else {
							processMaterials(gltf.scene);
						}
						this.scene.add(gltf.scene);
						this.meshes[index] = gltf.scene;
						this.loadedCount++;
						activeLoads--;

						this.onLoadProgress(this.loadedCount, urls.length);

						// Show first frame as soon as it's ready
						if (!firstFrameShown && this.meshes[0]) {
							this.setFrame(0);
							firstFrameShown = true;
						}

						// Check if all loaded
						if (this.loadedCount === urls.length) {
							this.onLoadComplete();
						}

						loadNext();
					})
					.catch((error) => {
						console.error(`Error loading ${urls[index]}:`, error);
						activeLoads--;
						loadNext();
					});
			}
		};

		this.onLoadProgress(0, urls.length);
		loadNext();
	}

	/**
	 * Set the visible frame
	 * @param {number} index - Frame index to show
	 */
	setFrame(index) {
		if (index < 0 || index >= this.meshCount) return;
		if (index === this.currentIndex && this.meshes[this.currentIndex]?.visible) return;

		// Hide current mesh
		if (this.meshes[this.currentIndex]) {
			this.meshes[this.currentIndex].visible = false;
		}

		// Show new mesh
		if (this.meshes[index]) {
			this.meshes[index].visible = true;
		}

		this.currentIndex = index;
		this.onFrameChange(index, !!this.meshes[index]);
	}

	/**
	 * Get current frame index
	 * @returns {number}
	 */
	getFrame() {
		return this.currentIndex;
	}

	/**
	 * Check if a specific frame is loaded
	 * @param {number} index - Frame index
	 * @returns {boolean}
	 */
	isFrameLoaded(index) {
		return !!this.meshes[index];
	}

	/**
	 * Start playback
	 */
	play() {
		if (this.isPlaying) return;
		this.isPlaying = true;
		this._playLoop();
	}

	/**
	 * Pause playback
	 */
	pause() {
		this.isPlaying = false;
		if (this.playTimeoutId) {
			clearTimeout(this.playTimeoutId);
			this.playTimeoutId = null;
		}
	}

	/**
	 * Toggle play/pause
	 * @returns {boolean} - New playing state
	 */
	togglePlay() {
		if (this.isPlaying) {
			this.pause();
		} else {
			this.play();
		}
		return this.isPlaying;
	}

	/**
	 * Set playback speed
	 * @param {number} speed - Milliseconds per frame
	 */
	setPlaySpeed(speed) {
		this.playSpeed = speed;
	}

	/**
	 * Get playback speed
	 * @returns {number}
	 */
	getPlaySpeed() {
		return this.playSpeed;
	}

	/**
	 * Internal playback loop
	 * @private
	 */
	_playLoop() {
		if (!this.isPlaying || this.isDisposed) return;

		const nextIndex = (this.currentIndex + 1) % this.meshCount;
		this.setFrame(nextIndex);

		this.playTimeoutId = setTimeout(() => this._playLoop(), this.playSpeed);
	}

	/**
	 * Step forward one frame
	 */
	stepForward() {
		this.pause();
		const nextIndex = Math.min(this.currentIndex + 1, this.meshCount - 1);
		this.setFrame(nextIndex);
	}

	/**
	 * Step backward one frame
	 */
	stepBackward() {
		this.pause();
		const prevIndex = Math.max(this.currentIndex - 1, 0);
		this.setFrame(prevIndex);
	}

	/**
	 * Set visibility of the orientation marker (axes indicator)
	 * @param {boolean} visible - Whether the marker should be visible
	 */
	setAxesVisible(visible) {
		if (this.orientationMarker) {
			this.orientationMarker.setVisible(visible);
		}
	}

	/**
	 * Set camera to a preset view with smooth animation
	 * @param {string} viewName - One of: 'iso', 'top', 'bottom', 'front', 'back', 'left', 'right'
	 */
	setView(viewName) {
		const presets = {
			iso:    { pos: [1, -1, 1], up: [0, 0, 1] },
			top:    { pos: [0, 0, 1], up: [0, 1, 0] },
			bottom: { pos: [0, 0, -1], up: [0, -1, 0] },
			front:  { pos: [0, -1, 0], up: [0, 0, 1] },
			back:   { pos: [0, 1, 0], up: [0, 0, 1] },
			left:   { pos: [-1, 0, 0], up: [0, 0, 1] },
			right:  { pos: [1, 0, 0], up: [0, 0, 1] }
		};

		const preset = presets[viewName];
		if (!preset) return;

		// Preserve current zoom distance
		const distance = this.camera.position.length();

		// Calculate target position (normalized direction * distance)
		const targetPos = new THREE.Vector3(...preset.pos).normalize().multiplyScalar(distance);
		const targetUp = new THREE.Vector3(...preset.up);

		this._animateCameraTo(targetPos, targetUp);
	}

	/**
	 * Animate camera to target position with smooth transition
	 * @param {THREE.Vector3} targetPosition - Target camera position
	 * @param {THREE.Vector3} targetUp - Target up vector
	 * @private
	 */
	_animateCameraTo(targetPosition, targetUp) {
		const duration = 700; // ms
		const startTime = performance.now();

		// Store start state
		const startPos = this.camera.position.clone();
		const startUp = this.camera.up.clone();
		const distance = startPos.length();

		// Normalize directions for spherical interpolation
		const startDir = startPos.clone().normalize();
		const endDir = targetPosition.clone().normalize();

		// Use quaternion to rotate from start direction to end direction
		const rotationQuat = new THREE.Quaternion();
		rotationQuat.setFromUnitVectors(startDir, endDir);

		const animate = () => {
			if (this.isDisposed) return;

			const elapsed = performance.now() - startTime;
			const t = Math.min(elapsed / duration, 1);

			// Ease-out cubic
			const eased = 1 - Math.pow(1 - t, 3);

			// Interpolate position along spherical path (constant distance)
			const currentQuat = new THREE.Quaternion();
			currentQuat.slerpQuaternions(new THREE.Quaternion(), rotationQuat, eased);

			const currentDir = startDir.clone().applyQuaternion(currentQuat);
			this.camera.position.copy(currentDir.multiplyScalar(distance));

			// Interpolate up vector
			this.camera.up.lerpVectors(startUp, targetUp, eased).normalize();

			// Make camera look at origin
			this.camera.lookAt(0, 0, 0);

			// Update controls
			if (this.controls) {
				this.controls.target.set(0, 0, 0);
			}

			if (t < 1) {
				requestAnimationFrame(animate);
			} else {
				// Ensure final state is exact
				this.camera.position.copy(targetPosition);
				this.camera.up.copy(targetUp);
				this.camera.lookAt(0, 0, 0);

				// Reset controls to pick up new camera state
				if (this.controls) {
					this.controls.target.set(0, 0, 0);
					this.controls.update();
				}
			}
		};

		requestAnimationFrame(animate);
	}

	/**
	 * Dispose of the view and clean up resources
	 */
	dispose() {
		this.isDisposed = true;
		this.pause();

		// Remove from shared renderer
		sharedRenderer.removeView(this);

		// Dispose controls
		if (this.controls) {
			this.controls.dispose();
			this.controls = null;
		}

		// Dispose orientation marker
		if (this.orientationMarker) {
			this.orientationMarker.dispose();
			this.orientationMarker = null;
		}

		// Dispose all meshes
		for (const mesh of this.meshes) {
			if (mesh) {
				mesh.traverse((child) => {
					if (child.geometry) child.geometry.dispose();
					if (child.material) {
						if (Array.isArray(child.material)) {
							child.material.forEach(m => m.dispose());
						} else {
							child.material.dispose();
						}
					}
				});
				this.scene.remove(mesh);
			}
		}
		this.meshes = [];

		// Dispose lights
		if (this.lights) {
			Object.values(this.lights).forEach(light => {
				if (light.parent) light.parent.remove(light);
				if (light.dispose) light.dispose();
			});
			this.lights = null;
		}

		// Clear scene
		this.scene = null;
		this.camera = null;
	}
}
