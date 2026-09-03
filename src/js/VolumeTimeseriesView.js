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
 * - Volume textures array with ring buffer memory management
 * - Independent playback state
 * - Volume-specific controls (render mode, threshold, colormap, etc.)
 */
export default class VolumeTimeseriesView {
	/**
	 * Create a new volume timeseries view
	 * @param {Object} options - View configuration
	 * @param {HTMLElement} options.elem - DOM element to render into
	 * @param {string} options.basePath - Base path for volume files (e.g., 'public/volumes/')
	 * @param {number} options.frameCount - Number of volumes in the timeseries (default: from metadata)
	 * @param {number} options.loadConcurrency - Concurrent loads (default: 4)
	 * @param {number} options.maxLoadedVolumes - Max volumes in memory (default: 20)
	 * @param {number} options.prefetchCount - Frames to prefetch during playback (default: 5)
	 * @param {number} options.defaultPlaySpeed - Default playback speed in ms (default: 250)
	 * @param {boolean} options.enableControls - Enable TrackballControls (default: true)
	 * @param {string} options.colormap - Initial colormap (default: 'grayscale')
	 * @param {string} options.renderMode - Initial render mode: 'mip' or 'opacity' (default: 'mip')
	 * @param {number} options.threshold - Initial threshold 0-1 (default: 0.1)
	 * @param {number} options.opacity - Initial opacity 0-1 (default: 1.0)
	 * @param {number} options.stepCount - Ray marching steps (default: 256)
	 * @param {Function} options.onLoadProgress - Callback for load progress (loaded, total)
	 * @param {Function} options.onLoadComplete - Callback when initial load complete
	 * @param {Function} options.onFrameChange - Callback when frame changes (index)
	 * @param {Function} options.onMetadataLoaded - Callback when metadata is loaded (metadata)
	 */
	constructor(options) {
		this.elem = options.elem;
		this.basePath = options.basePath || 'data/volumes/';
		this.loadConcurrency = options.loadConcurrency || 4;
		this.maxLoadedVolumes = options.maxLoadedVolumes || 20;
		this.prefetchCount = options.prefetchCount || 5;
		this.defaultPlaySpeed = options.defaultPlaySpeed || 250;
		this.enableControls = options.enableControls !== false;

		// Volume rendering settings
		this.colormap = options.colormap || 'grayscale';
		this.renderMode = options.renderMode || 'mip';
		this.threshold = options.threshold ?? 0.01;
		this.opacity = options.opacity ?? 1.0;
		this.stepCount = options.stepCount || 256;

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
			concurrency: this.loadConcurrency,
			maxLoadedVolumes: this.maxLoadedVolumes
		});
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

			// Start loading first frame immediately, then background load
			await this._loadFirstFrame();

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
	 * Load the first frame and set up material
	 * @private
	 */
	async _loadFirstFrame() {
		if (this.volumeUrls.length === 0) {
			console.warn('VolumeTimeseriesView: No volume URLs to load');
			return;
		}

		try {
			this.onLoadProgress(0, this.frameCount);

			console.log('VolumeTimeseriesView: Loading first volume from', this.volumeUrls[0]);

			// Load first volume
			const firstTexture = await this.volumeLoader.loadVolume(
				this.volumeUrls[0],
				this.metadata
			);

			console.log('VolumeTimeseriesView: Volume texture created', {
				width: firstTexture.image.width,
				height: firstTexture.image.height,
				depth: firstTexture.image.depth
			});

			if (this.isDisposed) return;

			// Create proper volume material
			this.volumeMaterial = this.materialFactory.createMaterial(firstTexture, {
				colormap: this.colormap,
				threshold: this.threshold,
				opacity: this.opacity,
				stepCount: this.stepCount,
				renderMode: this.renderMode
			});

			console.log('VolumeTimeseriesView: Volume material created');

			// Replace placeholder material
			this.volumeBox.material = this.volumeMaterial;

			this.loadedCount = 1;
			this.onLoadProgress(1, this.frameCount);
			this.onFrameChange(0, true);

			// Start background loading of remaining frames
			this._loadRemainingFrames();

		} catch (error) {
			console.error('VolumeTimeseriesView: Failed to load first volume:', error);
		}
	}

	/**
	 * Load remaining frames in background
	 * @private
	 */
	async _loadRemainingFrames() {
		if (this.volumeUrls.length <= 1) {
			this.initialLoadComplete = true;
			this.onLoadComplete();
			return;
		}

		// Load remaining volumes with concurrency
		const remainingUrls = this.volumeUrls.slice(1);

		for (let i = 0; i < remainingUrls.length; i++) {
			if (this.isDisposed) return;

			try {
				await this.volumeLoader.loadVolume(remainingUrls[i], this.metadata);
				this.loadedCount++;
				this.onLoadProgress(this.loadedCount, this.frameCount);
			} catch (error) {
				console.error(`Failed to load volume ${i + 2}:`, error);
			}
		}

		this.initialLoadComplete = true;
		this.onLoadComplete();
	}

	/**
	 * Set the visible frame
	 * @param {number} index - Frame index to show
	 */
	async setFrame(index) {
		if (index < 0 || index >= this.frameCount) return;
		if (index === this.currentIndex && this.volumeLoader.isCached(this.volumeUrls[index])) return;

		this.currentIndex = index;

		const url = this.volumeUrls[index];
		const cachedTexture = this.volumeLoader.getCached(url);

		if (cachedTexture) {
			// Update material with cached texture
			this._updateVolumeTexture(cachedTexture);
			this.onFrameChange(index, true);
		} else {
			// Need to load - show loading state
			this.onFrameChange(index, false);

			try {
				const texture = await this.volumeLoader.loadVolume(url, this.metadata);
				if (!this.isDisposed && this.currentIndex === index) {
					this._updateVolumeTexture(texture);
					this.onFrameChange(index, true);
				}
			} catch (error) {
				console.error(`Failed to load frame ${index}:`, error);
			}
		}

		// Prefetch upcoming frames during playback
		if (this.isPlaying) {
			this.volumeLoader.prefetch(this.volumeUrls, this.metadata, index, this.prefetchCount);
		}
	}

	/**
	 * Update volume texture in material
	 * @private
	 */
	_updateVolumeTexture(texture) {
		if (this.volumeMaterial && this.volumeMaterial.uniforms) {
			this.materialFactory.updateMaterial(this.volumeMaterial, {
				volumeTexture: texture,
				updateJitter: true
			});
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
		return this.volumeLoader.isCached(this.volumeUrls[index]);
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
	 * Set render mode
	 * @param {string} mode - 'mip' or 'opacity'
	 */
	setRenderMode(mode) {
		this.renderMode = mode;
		if (this.volumeMaterial) {
			this.materialFactory.updateMaterial(this.volumeMaterial, { renderMode: mode });
		}
	}

	/**
	 * Get current render mode
	 * @returns {string}
	 */
	getRenderMode() {
		return this.renderMode;
	}

	/**
	 * Set visibility threshold
	 * @param {number} threshold - Threshold 0-1
	 */
	setThreshold(threshold) {
		this.threshold = threshold;
		if (this.volumeMaterial) {
			this.materialFactory.updateMaterial(this.volumeMaterial, { threshold });
		}
	}

	/**
	 * Get current threshold
	 * @returns {number}
	 */
	getThreshold() {
		return this.threshold;
	}

	/**
	 * Set global opacity
	 * @param {number} opacity - Opacity 0-1
	 */
	setOpacity(opacity) {
		this.opacity = opacity;
		if (this.volumeMaterial) {
			this.materialFactory.updateMaterial(this.volumeMaterial, { opacity });
		}
	}

	/**
	 * Get current opacity
	 * @returns {number}
	 */
	getOpacity() {
		return this.opacity;
	}

	/**
	 * Set colormap
	 * @param {string} name - Colormap name
	 */
	setColormap(name) {
		this.colormap = name;
		if (this.volumeMaterial) {
			this.materialFactory.updateMaterial(this.volumeMaterial, { colormap: name });
		}
	}

	/**
	 * Get current colormap
	 * @returns {string}
	 */
	getColormap() {
		return this.colormap;
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
	 * Get available colormap names
	 * @returns {string[]}
	 */
	getColormapNames() {
		return this.materialFactory ? this.materialFactory.getColormapNames() : [];
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

		// Dispose volume loader (clears texture cache)
		if (this.volumeLoader) {
			this.volumeLoader.dispose();
			this.volumeLoader = null;
		}

		// Dispose material factory (clears colormap textures)
		if (this.materialFactory) {
			this.materialFactory.dispose();
			this.materialFactory = null;
		}

		// Clear scene
		this.scene = null;
		this.camera = null;
	}
}
