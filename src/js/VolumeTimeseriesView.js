import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import sharedRenderer from './SharedRenderer.js';
import VolumeLoader from './VolumeLoader.js';
import VolumeMaterialFactory from './VolumeMaterialFactory.js';
import OrientationMarker from './OrientationMarker.js';

/**
 * VolumeTimeseriesView - Encapsulates a single volume timeseries view
 *
 * Each view has its own:
 * - Scene with volume rendering box
 * - Camera with TrackballControls
 * - One persistent R8 3D texture, updated in place from a decoded-frame cache
 * - Independent playback state
 * - Volume-specific controls (contrast limits, gamma)
 */
export default class VolumeTimeseriesView {
	/**
	 * Create a new volume timeseries view
	 * @param {Object} options - View configuration
	 * @param {HTMLElement} options.elem - DOM element to render into
	 * @param {string} options.basePath - Base path for volume files (e.g., 'public/volumes/')
	 * @param {number} options.frameCount - Number of volumes in the timeseries (default: from metadata)
	 * @param {number} options.loadConcurrency - Concurrent fetches of compressed frames (default: 12)
	 * @param {number} options.maxDecodedFrames - Decoded frames kept in memory, ~10 MB each (default: 16)
	 * @param {number} options.prefetchRadius - Frames decoded ahead/behind the current one (default: 6)
	 * @param {number} options.defaultPlaySpeed - Default playback speed in ms (default: 250)
	 * @param {boolean} options.enableControls - Enable TrackballControls (default: true)
	 * @param {number} options.contrastMin - Initial lower contrast limit 0-1 (default: 0.1)
	 * @param {number} options.contrastMax - Initial upper contrast limit 0-1 (default: 1.0)
	 * @param {number} options.gamma - Initial gamma exponent (default: 1.0)
	 * @param {number} options.stepCount - Ray marching steps (default: 512)
	 * @param {Function} options.onLoadProgress - Callback for load progress (loaded, total)
	 * @param {Function} options.onLoadComplete - Callback when initial load complete
	 * @param {Function} options.onFrameChange - Callback when frame changes (index)
	 * @param {Function} options.onMetadataLoaded - Callback when metadata is loaded (metadata)
	 */
	constructor(options) {
		this.elem = options.elem;
		this.basePath = options.basePath || 'data/volumes/';
		this.loadConcurrency = options.loadConcurrency || 12;
		this.maxDecodedFrames = options.maxDecodedFrames || 16;
		this.prefetchRadius = options.prefetchRadius || 6;
		this.defaultPlaySpeed = options.defaultPlaySpeed || 250;
		this.enableControls = options.enableControls !== false;

		// Volume rendering settings
		this.contrastMin = options.contrastMin ?? 0.1;
		this.contrastMax = options.contrastMax ?? 1.0;
		this.gamma = options.gamma ?? 1.0;
		this.stepCount = options.stepCount || 512;

		// Callbacks
		this.onLoadProgress = options.onLoadProgress || (() => {});
		this.onLoadComplete = options.onLoadComplete || (() => {});
		this.onFrameChange = options.onFrameChange || (() => {});
		this.onMetadataLoaded = options.onMetadataLoaded || (() => {});

		// State
		this.metadata = null;
		this.frameCount = options.frameCount || 0;
		this.volumeUrls = [];
		this.currentIndex = 0;
		this.isPlaying = false;
		this.playTimeoutId = null;
		this.playSpeed = this.defaultPlaySpeed;
		this.loadedCount = 0;
		this.isDisposed = false;
		this.initialLoadComplete = false;

		// Three.js objects
		this.scene = null;
		this.camera = null;
		this.controls = null;
		this.volumeBox = null;
		this.volumeMaterial = null;
		this.volumeTexture = null;
		this.appliedIndex = -1;
		this.orientationMarker = null;

		// Volume infrastructure
		this.volumeLoader = null;
		this.materialFactory = null;

		this._init();
	}

	/**
	 * Initialize the view
	 * @private
	 */
	async _init() {
		// Create scene
		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x000000);

		// Create camera
		this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
		this.camera.position.set(1, 1, 1);

		// Create controls
		if (this.enableControls) {
			this.controls = new TrackballControls(this.camera, this.elem);
			this.controls.rotateSpeed = 2.0;
			this.controls.zoomSpeed = 1.2;
			this.controls.panSpeed = 0.8;
			this.controls.staticMoving = false;
			this.controls.dynamicDampingFactor = 0.6;
		}

		// Create orientation marker with light text for volume viewer
		this.orientationMarker = new OrientationMarker({ labelColor: 0xcccccc });

		// Create volume loader and material factory
		this.volumeLoader = new VolumeLoader({
			fetchConcurrency: this.loadConcurrency,
			maxDecodedFrames: this.maxDecodedFrames
		});
		this.volumeLoader.onDecoded = (index, data) => this._onFrameDecoded(index, data);
		this.materialFactory = new VolumeMaterialFactory();

		// Register with shared renderer
		sharedRenderer.addView(this);

		// Load metadata and start loading volumes
		await this._loadMetadataAndStart();
	}

	/**
	 * Load metadata and initialize volume loading
	 * @private
	 */
	async _loadMetadataAndStart() {
		try {
			// Load metadata
			const metadataUrl = this.basePath + 'metadata.json';
			this.metadata = await this.volumeLoader.loadMetadata(metadataUrl);

			// The explicit file list is authoritative for the frame count; a hand-edited
			// frameCount that disagrees with it is corrected (with a warning).
			const files = Array.isArray(this.metadata.files) ? this.metadata.files : null;
			if (files) {
				if (this.metadata.frameCount != null && this.metadata.frameCount !== files.length) {
					console.warn(`VolumeTimeseriesView: metadata.frameCount (${this.metadata.frameCount}) ` +
						`does not match files.length (${files.length}); using files.length`);
				}
				this.metadata.frameCount = files.length;
			}
			this.frameCount = this.metadata.frameCount || 0;

			// Generate volume URLs
			this.volumeUrls = this._generateVolumeUrls();

			// Notify metadata loaded
			this.onMetadataLoaded(this.metadata);

			// Create volume box geometry based on dimensions
			this._createVolumeBox();

			// Fetch every frame's compressed bytes, decode outward from frame 0
			this._startLoading();

		} catch (error) {
			console.error('Failed to load volume metadata:', error);
		}
	}

	/**
	 * Generate volume URLs from metadata
	 * @private
	 */
	_generateVolumeUrls() {
		const urls = [];

		if (Array.isArray(this.metadata.files)) {
			// Use explicit file list
			for (const file of this.metadata.files) {
				urls.push(this.basePath + file);
			}
		} else {
			// Use file pattern (0-based, brotli-compressed, as written by convert-zarr-to-bin.py)
			const pattern = this.metadata.filePattern || '{index:04d}.bin.br';
			for (let i = 0; i < this.frameCount; i++) {
				const filename = pattern.replace('{index:04d}', String(i).padStart(4, '0'));
				urls.push(this.basePath + filename);
			}
		}

		return urls;
	}

	/**
	 * Create the volume box geometry
	 * @private
	 */
	_createVolumeBox() {
		if (!this.metadata) return;

		const [width, height, depth] = this.metadata.dimensions;
		const spacing = this.metadata.spacing || [1, 1, 1];

		// Calculate actual size with spacing
		const sizeX = width * spacing[0];
		const sizeY = height * spacing[1];
		const sizeZ = depth * spacing[2];

		// Normalize to unit cube centered at origin
		const maxDim = Math.max(sizeX, sizeY, sizeZ);
		const normalizedSize = new THREE.Vector3(
			sizeX / maxDim,
			sizeY / maxDim,
			sizeZ / maxDim
		);

		// Create box geometry (unit cube that will be scaled)
		const geometry = new THREE.BoxGeometry(1, 1, 1);

		// Shift geometry so it's centered and goes from 0 to 1 in texture coords
		geometry.translate(0.5, 0.5, 0.5);

		// Create placeholder material (will be updated when texture loads)
		this.volumeMaterial = new THREE.MeshBasicMaterial({
			color: 0x444444,
			wireframe: true
		});

		this.volumeBox = new THREE.Mesh(geometry, this.volumeMaterial);
		this.volumeBox.scale.copy(normalizedSize);

		// Center the box
		this.volumeBox.position.set(
			-normalizedSize.x / 2,
			-normalizedSize.y / 2,
			-normalizedSize.z / 2
		);

		this.scene.add(this.volumeBox);

		// Adjust camera based on volume size
		const distance = Math.max(normalizedSize.x, normalizedSize.y, normalizedSize.z) * .72;
		this.camera.position.set(distance, distance, distance);
		this.camera.lookAt(0, 0, 0);

		if (this.controls) {
			this.controls.target.set(0, 0, 0);
		}
	}

	/**
	 * Start fetching all compressed frames and decoding around the current one
	 * @private
	 */
	_startLoading() {
		if (this.volumeUrls.length === 0) {
			console.warn('VolumeTimeseriesView: No volume URLs to load');
			return;
		}

		this.volumeLoader.fetchAll(
			this.volumeUrls,
			this.metadata,
			(fetched, total) => {
				this.loadedCount = fetched;
				this.onLoadProgress(fetched, total);
			},
			() => {
				this.initialLoadComplete = true;
				this.onLoadComplete();
			}
		);

		this.setFrame(this.currentIndex);
	}

	/**
	 * Point the decode queue at a frame and request its neighbourhood
	 * @private
	 */
	_requestFrame(index) {
		this.volumeLoader.setTarget(index, {
			forwardBias: this.isPlaying,
			pruneRadius: this.prefetchRadius * 2
		});
		this.volumeLoader.requestDecode(index);
		for (let r = 1; r <= this.prefetchRadius; r++) {
			this.volumeLoader.requestDecode(index + r);
			this.volumeLoader.requestDecode(index - r);
		}
	}

	/**
	 * A worker finished decoding a frame; show it if it is still the one wanted
	 * @private
	 */
	_onFrameDecoded(index, data) {
		if (this.isDisposed) return;
		if (index === this.currentIndex) {
			this._applyFrame(index, data);
		}
	}

	/**
	 * Upload decoded voxels into the persistent texture (created on first use)
	 * @private
	 */
	_applyFrame(index, data) {
		if (!this.volumeTexture) {
			this.volumeTexture = this.volumeLoader.createTexture(data);
			this.volumeMaterial = this.materialFactory.createMaterial(this.volumeTexture, {
				contrastMin: this.contrastMin,
				contrastMax: this.contrastMax,
				gamma: this.gamma,
				stepCount: this.stepCount
			});
			this.volumeBox.material = this.volumeMaterial;
		} else if (this.volumeTexture.image.data !== data) {
			// Same size and format as the original allocation, so three.js re-uploads
			// with texSubImage3D into the existing storage instead of reallocating.
			this.volumeTexture.image.data = data;
			this.volumeTexture.needsUpdate = true;
		}

		this.materialFactory.updateMaterial(this.volumeMaterial, { updateJitter: true });
		this.appliedIndex = index;
		this.onFrameChange(index, true);
	}

	/**
	 * Set the visible frame. Synchronous and cheap: if the frame is decoded it is shown
	 * immediately, otherwise it becomes the decode target and appears when ready.
	 * @param {number} index - Frame index to show
	 */
	setFrame(index) {
		if (index < 0 || index >= this.frameCount) return;
		if (index === this.currentIndex && index === this.appliedIndex) return;

		this.currentIndex = index;
		this.volumeLoader.pin(index);
		this._requestFrame(index);

		const data = this.volumeLoader.getDecoded(index);
		if (data) {
			this._applyFrame(index, data);
		} else {
			this.onFrameChange(index, false);
		}
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
		return this.volumeLoader.hasDecoded(index);
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
	 * Set playback speed in frames per second
	 * @param {number} fps - Frames per second (> 0)
	 */
	setFps(fps) {
		if (!(fps > 0)) return;
		this.playSpeed = 1000 / fps;
	}

	/**
	 * Get playback speed in frames per second
	 * @returns {number}
	 */
	getFps() {
		return 1000 / this.playSpeed;
	}

	/**
	 * Internal playback loop
	 * @private
	 */
	_playLoop() {
		if (!this.isPlaying || this.isDisposed) return;

		const nextIndex = (this.currentIndex + 1) % this.frameCount;
		this.setFrame(nextIndex);

		this.playTimeoutId = setTimeout(() => this._playLoop(), this.playSpeed);
	}

	/**
	 * Step forward one frame
	 */
	stepForward() {
		this.pause();
		const nextIndex = Math.min(this.currentIndex + 1, this.frameCount - 1);
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

	// Volume-specific methods

	/**
	 * Set contrast limits (like ImageJ / napari). Voxels at or below min are
	 * hidden, voxels at or above max saturate to white.
	 * @param {number} min - Lower limit 0-1
	 * @param {number} max - Upper limit 0-1
	 */
	setContrastLimits(min, max) {
		this.contrastMin = Math.min(min, max);
		this.contrastMax = Math.max(min, max);
		if (this.volumeMaterial) {
			this.materialFactory.updateMaterial(this.volumeMaterial, {
				contrastMin: this.contrastMin,
				contrastMax: this.contrastMax
			});
		}
	}

	/**
	 * Get current contrast limits
	 * @returns {{min: number, max: number}}
	 */
	getContrastLimits() {
		return { min: this.contrastMin, max: this.contrastMax };
	}

	/**
	 * Set the lower contrast limit only (kept for backward compatibility)
	 * @param {number} threshold - Threshold 0-1
	 */
	setThreshold(threshold) {
		this.setContrastLimits(threshold, this.contrastMax);
	}

	/**
	 * Get the lower contrast limit
	 * @returns {number}
	 */
	getThreshold() {
		return this.contrastMin;
	}

	/**
	 * Set gamma exponent applied after contrast limits (napari convention: value ^ gamma).
	 * Values below 1 brighten dim voxels, values above 1 darken them.
	 * @param {number} gamma - Gamma exponent (> 0)
	 */
	setGamma(gamma) {
		this.gamma = Math.max(0.01, gamma);
		if (this.volumeMaterial) {
			this.materialFactory.updateMaterial(this.volumeMaterial, { gamma: this.gamma });
		}
	}

	/**
	 * Get current gamma
	 * @returns {number}
	 */
	getGamma() {
		return this.gamma;
	}

	/**
	 * Set ray marching step count
	 * @param {number} count - Step count (64-512)
	 */
	setStepCount(count) {
		this.stepCount = Math.max(64, Math.min(512, count));
		if (this.volumeMaterial) {
			this.materialFactory.updateMaterial(this.volumeMaterial, { stepCount: this.stepCount });
		}
	}

	/**
	 * Get current step count
	 * @returns {number}
	 */
	getStepCount() {
		return this.stepCount;
	}

	/**
	 * Set visibility of the orientation marker
	 * @param {boolean} visible
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

		const distance = this.camera.position.length();
		const targetPos = new THREE.Vector3(...preset.pos).normalize().multiplyScalar(distance);
		const targetUp = new THREE.Vector3(...preset.up);

		this._animateCameraTo(targetPos, targetUp);
	}

	/**
	 * Animate camera to target position
	 * @private
	 */
	_animateCameraTo(targetPosition, targetUp) {
		const duration = 700;
		const startTime = performance.now();

		const startPos = this.camera.position.clone();
		const startUp = this.camera.up.clone();
		const distance = startPos.length();

		const startDir = startPos.clone().normalize();
		const endDir = targetPosition.clone().normalize();

		const rotationQuat = new THREE.Quaternion();
		rotationQuat.setFromUnitVectors(startDir, endDir);

		const animate = () => {
			if (this.isDisposed) return;

			const elapsed = performance.now() - startTime;
			const t = Math.min(elapsed / duration, 1);
			const eased = 1 - Math.pow(1 - t, 3);

			const currentQuat = new THREE.Quaternion();
			currentQuat.slerpQuaternions(new THREE.Quaternion(), rotationQuat, eased);

			const currentDir = startDir.clone().applyQuaternion(currentQuat);
			this.camera.position.copy(currentDir.multiplyScalar(distance));
			this.camera.up.lerpVectors(startUp, targetUp, eased).normalize();
			this.camera.lookAt(0, 0, 0);

			if (this.controls) {
				this.controls.target.set(0, 0, 0);
			}

			if (t < 1) {
				requestAnimationFrame(animate);
			} else {
				this.camera.position.copy(targetPosition);
				this.camera.up.copy(targetUp);
				this.camera.lookAt(0, 0, 0);

				if (this.controls) {
					this.controls.target.set(0, 0, 0);
					this.controls.update();
				}
			}
		};

		requestAnimationFrame(animate);
	}

	/**
	 * Get cache statistics
	 * @returns {Object}
	 */
	getCacheStats() {
		return this.volumeLoader ? this.volumeLoader.getCacheStats() : null;
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

		// Dispose volume box
		if (this.volumeBox) {
			if (this.volumeBox.geometry) {
				this.volumeBox.geometry.dispose();
			}
			this.scene.remove(this.volumeBox);
			this.volumeBox = null;
		}

		// Dispose material
		if (this.volumeMaterial) {
			this.volumeMaterial.dispose();
			this.volumeMaterial = null;
		}

		// Dispose the persistent volume texture
		if (this.volumeTexture) {
			this.volumeTexture.dispose();
			this.volumeTexture = null;
		}

		// Dispose volume loader (terminates its share of the decode workers)
		if (this.volumeLoader) {
			this.volumeLoader.dispose();
			this.volumeLoader = null;
		}

		// Dispose material factory
		if (this.materialFactory) {
			this.materialFactory.dispose();
			this.materialFactory = null;
		}

		// Clear scene
		this.scene = null;
		this.camera = null;
	}
}
