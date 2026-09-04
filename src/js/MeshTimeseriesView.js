import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import sharedRenderer from './SharedRenderer.js';
import { createSurfaceMaterial, applySurfaceMaterial, setUseVertexColors } from './MaterialFactory.js';
import OrientationMarker from './OrientationMarker.js';
import Coverslip from './Coverslip.js';
import { BACKGROUND, COVERSLIP } from './RenderStyle.js';

// Discovery tuning: HEAD probes issued in parallel per round, and the largest
// index offset probed before giving up (safety cap for runaway sequences).
const PROBE_FANOUT = 8;
const MAX_PROBE_OFFSET = 1 << 17;

// Discovery results shared between views that point at the same file sequence,
// so several views of one dataset probe the server only once.
const discoveryCache = new Map();

/**
 * MeshTimeseriesView - Encapsulates a single mesh timeseries view
 *
 * Each view has its own:
 * - Scene with a napari-style shaded surface material and a coverslip slab
 * - A frame group holding every mesh, shifted by one fixed XY offset so the
 *   first frame is centred on the coverslip and later frames keep their
 *   registered motion relative to it
 * - Camera with TrackballControls
 * - Meshes array for the timeseries
 * - Independent playback state
 */
export default class MeshTimeseriesView {
	/**
	 * Create a new mesh timeseries view
	 * @param {Object} options - View configuration
	 * @param {HTMLElement} options.elem - DOM element to render into
	 * @param {string} options.basePath - Base path for mesh files (e.g., 'data/meshes/mesh')
	 * @param {number} [options.meshCount] - Number of meshes; omit to discover the count from the server
	 * @param {number} [options.startIndex] - Index of the first file (0 or 1); omit to auto-detect
	 * @param {number} options.padWidth - Zero-padding width of the file index (default: 4)
	 * @param {string} options.fileExtension - File extension (default: '.glb')
	 * @param {number} options.loadConcurrency - Concurrent loads (default: 12)
	 * @param {number} options.defaultPlaySpeed - Default playback speed in ms (default: 250)
	 * @param {boolean} options.enableControls - Enable OrbitControls (default: true)
	 * @param {boolean} options.useVertexColors - Use vertex colors from mesh (default: false)
	 * @param {boolean} options.showCoverslip - Show the coverslip slab under the cell (default: true)
	 * @param {number} options.coverslipSize - Square footprint of the coverslip in mesh units (default: 200)
	 * @param {number} options.coverslipThickness - Coverslip thickness in mesh units (default: 12)
	 * @param {number} options.coverslipOpacity - Opacity of the coverslip body (default: 0.5)
	 * @param {Function} options.onLoadProgress - Callback for load progress (loaded, total)
	 * @param {Function} options.onLoadComplete - Callback when all meshes loaded
	 * @param {Function} options.onFrameChange - Callback when frame changes (index)
	 * @param {Function} options.onCountResolved - Callback once the mesh count is known (count, startIndex)
	 */
	constructor(options) {
		this.elem = options.elem;
		this.basePath = options.basePath;
		// An explicit count skips discovery; anything else means "ask the server"
		const explicitCount = Number(options.meshCount);
		this.meshCount = Number.isFinite(explicitCount) && explicitCount > 0 ? Math.floor(explicitCount) : 0;
		this.startIndex = Number.isInteger(options.startIndex) ? options.startIndex : null;
		this.padWidth = options.padWidth || 4;
		this.fileExtension = options.fileExtension || '.glb';
		this.loadConcurrency = options.loadConcurrency || 12;
		this.defaultPlaySpeed = options.defaultPlaySpeed || 250;
		this.enableControls = options.enableControls !== false;
		this.useVertexColors = options.useVertexColors || false;
		this.showCoverslip = options.showCoverslip !== false;
		this.coverslipSize = options.coverslipSize ?? COVERSLIP.padSize;
		this.coverslipThickness = options.coverslipThickness ?? COVERSLIP.thickness;
		this.coverslipOpacity = options.coverslipOpacity ?? COVERSLIP.meshBodyOpacity;

		// Callbacks
		this.onLoadProgress = options.onLoadProgress || (() => {});
		this.onLoadComplete = options.onLoadComplete || (() => {});
		this.onFrameChange = options.onFrameChange || (() => {});
		this.onCountResolved = options.onCountResolved || (() => {});

		// State (meshes and frameBounds are filled by index once the count is known)
		this.meshes = [];
		this.frameBounds = [];
		this.currentIndex = 0;
		this.isPlaying = false;
		this.playTimeoutId = null;
		this.playSpeed = this.defaultPlaySpeed;
		this.loadedCount = 0;
		this.isDisposed = false;
		// Incremented by setDataset() so loads still in flight for a previous dataset
		// can recognise they are stale and discard their results.
		this.loadGeneration = 0;

		// Three.js objects
		this.scene = null;
		this.camera = null;
		this.controls = null;
		this.surfaceMaterial = null;
		this.frameRoot = null;
		this.coverslip = null;
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
		this.scene.background = new THREE.Color(BACKGROUND.mesh);

		// Create camera
		this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
		// Start in the 'top' preset (looking down world Z, see setView)
		this.camera.position.set(0, 0, 260);
		this.camera.up.set(0, 1, 0);
		this.camera.lookAt(0, 0, 0);

		// One surface material shared by every frame (napari-style shading + baked AO)
		this.surfaceMaterial = createSurfaceMaterial({ useVertexColors: this.useVertexColors });

		// Coverslip slab, seated under the first frame once its bounds are known
		this.coverslip = new Coverslip({
			sizeX: this.coverslipSize,
			sizeY: this.coverslipSize,
			thickness: this.coverslipThickness,
			edgeColor: COVERSLIP.edgeColorLight,
			bodyOpacity: this.coverslipOpacity
		});
		this.coverslip.setVisible(false);
		this.scene.add(this.coverslip.group);

		// Every frame is parented here. The group is translated once, when the first
		// frame loads, so that frame is centred over the coverslip in XY; because the
		// same translation applies to all frames the registration between them is kept.
		this.frameRoot = new THREE.Group();
		this.frameRoot.name = 'frames';
		this.scene.add(this.frameRoot);

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

		// Resolve the mesh count (explicit or discovered), then load
		this._start();
	}

	/**
	 * Resolve the mesh count (explicit option or server discovery), then start loading
	 * @private
	 */
	async _start() {
		const generation = this.loadGeneration;
		try {
			if (this.meshCount > 0) {
				// Explicit count: only the numbering origin needs detecting
				if (this.startIndex === null) {
					const detected = await this._detectStartIndex();
					if (this._isStale(generation)) return;
					this.startIndex = detected ?? 1;
				}
			} else {
				const { startIndex, count } = await this._discoverMeshRange();
				if (this._isStale(generation)) return;
				this.startIndex = startIndex;
				this.meshCount = count;
			}

			console.log(`MeshTimeseriesView: ${this.meshCount} meshes at ${this.basePath} (start index ${this.startIndex})`);
			this.onCountResolved(this.meshCount, this.startIndex);

			if (this.meshCount === 0) {
				console.warn(`MeshTimeseriesView: no mesh files found, expected e.g. ${this._urlFor(this.startIndex)}`);
				this.onLoadComplete();
				return;
			}

			this._loadAllMeshes();
		} catch (error) {
			console.error('MeshTimeseriesView: failed to resolve mesh files:', error);
		}
	}

	/**
	 * True once the view is disposed or a newer dataset has replaced the one that
	 * started the work tagged with `generation`.
	 * @private
	 * @param {number} generation
	 * @returns {boolean}
	 */
	_isStale(generation) {
		return this.isDisposed || generation !== this.loadGeneration;
	}

	/**
	 * Swap the mesh sequence shown by this view while keeping the scene, camera,
	 * controls and lights. The frame resets to 0; camera orientation is preserved.
	 * @param {Object} options
	 * @param {string} options.basePath - New file prefix (e.g. 'data/meshes2/mesh')
	 * @param {number} [options.meshCount] - Explicit count; omit to discover from the server
	 * @param {number} [options.startIndex] - Explicit numbering origin; omit to detect
	 * @param {boolean} [options.useVertexColors] - Defaults to the current setting
	 */
	setDataset(options = {}) {
		if (this.isDisposed) return;
		this.pause();
		this.loadGeneration++;

		this._disposeMeshes();

		this.basePath = options.basePath ?? this.basePath;
		const explicitCount = Number(options.meshCount);
		this.meshCount = Number.isFinite(explicitCount) && explicitCount > 0 ? Math.floor(explicitCount) : 0;
		this.startIndex = Number.isInteger(options.startIndex) ? options.startIndex : null;
		if (typeof options.useVertexColors === 'boolean') {
			this.useVertexColors = options.useVertexColors;
		}
		setUseVertexColors(this.surfaceMaterial, this.useVertexColors);
		if (this.coverslip) this.coverslip.setVisible(false);
		if (this.frameRoot) this.frameRoot.position.set(0, 0, 0);
		this.currentIndex = 0;
		this.loadedCount = 0;

		this.onFrameChange(0, false);
		this._start();
	}

	/**
	 * Get the file prefix of the dataset currently shown
	 * @returns {string}
	 */
	getBasePath() {
		return this.basePath;
	}

	/**
	 * Release the GPU resources of one loaded GLTF scene. The shared surface
	 * material is kept; it is released in dispose().
	 * @private
	 * @param {THREE.Object3D} root
	 */
	_disposeObject(root) {
		root.traverse((child) => {
			if (child.geometry) child.geometry.dispose();
			if (child.material && child.material !== this.surfaceMaterial) {
				if (Array.isArray(child.material)) {
					child.material.forEach(m => m.dispose());
				} else {
					child.material.dispose();
				}
			}
		});
	}

	/**
	 * Remove and dispose every loaded mesh (scene, camera and lights are kept)
	 * @private
	 */
	_disposeMeshes() {
		for (const mesh of this.meshes) {
			if (mesh) {
				this._disposeObject(mesh);
				if (mesh.parent) mesh.parent.remove(mesh);
			}
		}
		this.meshes = [];
		this.frameBounds = [];
	}

	/**
	 * Build the URL of one mesh file
	 * @private
	 * @param {number} index - File index (not frame index)
	 * @returns {string}
	 */
	_urlFor(index) {
		return `${this.basePath}${String(index).padStart(this.padWidth, '0')}${this.fileExtension}`;
	}

	/**
	 * Generate file URLs for all meshes
	 * @private
	 * @returns {string[]}
	 */
	_generateFileUrls() {
		const urls = [];
		const start = this.startIndex ?? 1;
		for (let i = 0; i < this.meshCount; i++) {
			urls.push(this._urlFor(start + i));
		}
		return urls;
	}

	/**
	 * Check whether a mesh file exists on the server without downloading it
	 * @private
	 * @param {number} index - File index
	 * @returns {Promise<boolean>}
	 */
	async _probeExists(index) {
		const url = this._urlFor(index);
		try {
			let response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
			if (response.status === 405 || response.status === 501) {
				// Static host without HEAD support: ask for a single byte instead
				response = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
				response.body?.cancel();
			}
			// Vite's dev/preview servers answer missing files with index.html (HTTP 200),
			// so a successful status alone does not prove the file exists.
			const type = response.headers.get('content-type') || '';
			return response.ok && !type.includes('text/html');
		} catch (error) {
			return false;
		}
	}

	/**
	 * Detect whether the sequence starts at index 0 or 1
	 * @private
	 * @returns {Promise<number|null>} 0 or 1, or null if neither file exists
	 */
	async _detectStartIndex() {
		const [hasZero, hasOne] = await Promise.all([this._probeExists(0), this._probeExists(1)]);
		if (hasZero) return 0;
		if (hasOne) return 1;
		return null;
	}

	/**
	 * Discover the numbering origin and the number of contiguous mesh files,
	 * sharing the result with other views of the same sequence
	 * @private
	 * @returns {Promise<{startIndex: number, count: number}>}
	 */
	_discoverMeshRange() {
		const key = `${this.basePath}|${this.fileExtension}|${this.padWidth}|${this.startIndex ?? 'auto'}`;
		if (!discoveryCache.has(key)) {
			const discovery = this._probeMeshRange().catch((error) => {
				discoveryCache.delete(key); // don't cache failures
				throw error;
			});
			discoveryCache.set(key, discovery);
		}
		return discoveryCache.get(key);
	}

	/**
	 * Find the last file of a contiguously numbered sequence with a galloping search:
	 * probe index offsets 1, 2, 4, 8, ... in parallel until the first miss, then narrow
	 * the bracket with parallel probes (about 24 HEAD requests for ~100 files).
	 * Numbering gaps are not supported: the first missing index ends the sequence.
	 * @private
	 * @returns {Promise<{startIndex: number, count: number}>}
	 */
	async _probeMeshRange() {
		// 1. Numbering origin
		let startIndex = this.startIndex;
		if (startIndex === null) {
			startIndex = await this._detectStartIndex();
			if (startIndex === null) return { startIndex: 1, count: 0 };
		} else if (!(await this._probeExists(startIndex))) {
			return { startIndex, count: 0 };
		}

		// 2. Galloping search for the first missing index
		const offsets = [];
		for (let offset = 1; offset <= MAX_PROBE_OFFSET; offset *= 2) offsets.push(offset);
		let lo = startIndex; // last index known to exist
		let hi = null;       // first index known to be missing
		for (let c = 0; c < offsets.length && hi === null; c += PROBE_FANOUT) {
			const chunk = offsets.slice(c, c + PROBE_FANOUT);
			const hits = await Promise.all(chunk.map((offset) => this._probeExists(startIndex + offset)));
			for (let k = 0; k < chunk.length; k++) {
				if (hits[k]) {
					lo = startIndex + chunk[k];
				} else {
					hi = startIndex + chunk[k];
					break;
				}
			}
		}
		if (hi === null) hi = lo + 1; // hit the safety cap: treat lo as the last file

		// 3. Narrow (lo, hi) until the two are adjacent
		while (hi - lo > 1) {
			const span = hi - lo;
			const k = Math.min(PROBE_FANOUT, span - 1);
			const points = Array.from({ length: k }, (_, j) => lo + Math.floor((j + 1) * span / (k + 1)));
			const hits = await Promise.all(points.map((point) => this._probeExists(point)));
			let newLo = lo;
			let newHi = hi;
			for (let j = 0; j < k; j++) {
				if (hits[j]) {
					newLo = points[j];
				} else {
					newHi = points[j];
					break;
				}
			}
			lo = newLo;
			hi = newHi;
		}

		return { startIndex, count: lo - startIndex + 1 };
	}

	/**
	 * Load all meshes with concurrency control
	 * @private
	 */
	_loadAllMeshes() {
		const generation = this.loadGeneration;
		const urls = this._generateFileUrls();
		const loader = sharedRenderer.getLoader();

		let activeLoads = 0;
		let nextIndex = 0;
		let settledCount = 0;
		let firstFrameShown = false;

		// Runs after every load, successful or not, so completion fires even when
		// some files are missing (an over-estimated explicit count, a bad file, ...)
		const onSettled = () => {
			settledCount++;
			activeLoads--;
			if (settledCount === urls.length && !this._isStale(generation)) {
				this.onLoadComplete();
			}
			loadNext();
		};

		const loadNext = () => {
			if (this._isStale(generation)) return;

			while (activeLoads < this.loadConcurrency && nextIndex < urls.length) {
				const index = nextIndex++;
				activeLoads++;

				loader.loadAsync(urls[index])
					.then((gltf) => {
						if (this._isStale(generation)) {
							// The view was disposed or switched dataset while this file was loading
							this._disposeObject(gltf.scene);
							return;
						}

						gltf.scene.visible = false;
						applySurfaceMaterial(gltf.scene, this.surfaceMaterial);
						// Bounds in the frame group's space (the GLBs share one origin); the
						// first frame centres the group in XY and seats the coverslip
						gltf.scene.updateMatrixWorld(true);
						this.frameBounds[index] = new THREE.Box3().setFromObject(gltf.scene);
						if (index === 0) this._centerFirstFrame();
						this.frameRoot.add(gltf.scene);
						this.meshes[index] = gltf.scene;
						this.loadedCount++;

						this.onLoadProgress(this.loadedCount, urls.length);

						// Show first frame as soon as it's ready
						if (!firstFrameShown && this.meshes[0]) {
							this.setFrame(0);
							firstFrameShown = true;
						}

						onSettled();
					})
					.catch((error) => {
						console.error(`Error loading ${urls[index]}:`, error);
						onSettled();
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
	 * Translate the whole timeseries so the first frame's bounding-box centre sits
	 * on the coverslip's centre (the origin) in XY, then seat the coverslip under
	 * that frame's lowest point. Both are done once and left alone: the camera is
	 * static, and following each frame's own bounding box would make the cell and
	 * the slab bob around during playback and destroy the registered motion.
	 * @private
	 */
	_centerFirstFrame() {
		const bounds = this.frameBounds[0];
		if (!bounds) return;

		// The group's Z is untouched, so bounds.min.z is also the world-space floor
		const center = bounds.getCenter(new THREE.Vector3());
		this.frameRoot.position.set(-center.x, -center.y, 0);

		this._seatCoverslip();
	}

	/**
	 * Place the coverslip so its top face touches the lowest point of the first frame
	 * @private
	 */
	_seatCoverslip() {
		if (!this.coverslip || !this.showCoverslip) return;
		const bounds = this.frameBounds[0];
		if (!bounds) return;
		this.coverslip.setTop(bounds.min.z + this.frameRoot.position.z);
		this.coverslip.setVisible(true);
	}

	/**
	 * Show or hide the coverslip slab
	 * @param {boolean} visible
	 */
	setCoverslipVisible(visible) {
		this.showCoverslip = visible;
		if (this.coverslip) {
			this.coverslip.setVisible(visible && !!this.frameBounds[0]);
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
		if (!this.isPlaying || this.isDisposed || this.meshCount === 0) return;

		const nextIndex = (this.currentIndex + 1) % this.meshCount;
		this.setFrame(nextIndex);

		this.playTimeoutId = setTimeout(() => this._playLoop(), this.playSpeed);
	}

	/**
	 * Step forward one frame
	 */
	stepForward() {
		this.pause();
		if (this.meshCount === 0) return;
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
		this._disposeMeshes();

		// Dispose the shared surface material and the coverslip
		if (this.surfaceMaterial) {
			this.surfaceMaterial.dispose();
			this.surfaceMaterial = null;
		}
		if (this.coverslip) {
			this.coverslip.dispose();
			this.coverslip = null;
		}

		// Clear scene
		this.scene = null;
		this.camera = null;
	}
}
