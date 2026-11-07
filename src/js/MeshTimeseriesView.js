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

// Camera distance used until the scene is fitted (and always in centred mode)
const DEFAULT_CAMERA_DISTANCE = 260;

// Margin left around the scene when the camera is fitted to it (1 = edge to edge)
const FIT_PADDING = 1.05;

/**
 * A positive number, or the fallback when the value is missing or not positive
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
const positiveOr = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

/**
 * MeshTimeseriesView - Encapsulates a single mesh timeseries view
 *
 * Each view has its own:
 * - Scene with a napari-style shaded surface material and a coverslip slab
 * - One or more mesh sequences played back together, aligned at frame 0 (frame i
 *   shows file i of every sequence; a sequence that has run out of frames is
 *   hidden until playback wraps)
 * - A frame group holding every mesh. In centred mode (default) the group is
 *   shifted by one fixed XY offset so the first frame of the first sequence is
 *   centred on the coverslip, and later frames keep their registered motion
 *   relative to it. With `centerFrames: false` the meshes are left at their
 *   absolute positions; the coverslip and the camera are fitted to the scene
 *   bounds instead (from each sequence's metadata.json when present, otherwise
 *   from the first frames).
 * - Camera with TrackballControls orbiting the scene target
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
	 * @param {Object[]} [options.sequences] - Several sequences rendered together, each
	 *   `{ basePath, meshCount?, startIndex? }`; takes precedence over basePath / meshCount / startIndex
	 * @param {boolean} options.centerFrames - Centre the first frame on the coverslip (default: true);
	 *   false keeps the meshes' absolute positions and fits the coverslip and camera to them
	 * @param {number} options.sceneRotation - Rotation of the meshes and coverslip about the
	 *   vertical (Z) axis in degrees, counterclockwise when seen from above (default: 0)
	 * @param {number} options.padWidth - Zero-padding width of the file index (default: 4)
	 * @param {string} options.fileExtension - File extension (default: '.glb')
	 * @param {number} options.loadConcurrency - Concurrent loads (default: 12)
	 * @param {number} options.defaultPlaySpeed - Default playback speed in ms (default: 250)
	 * @param {boolean} options.enableControls - Enable OrbitControls (default: true)
	 * @param {boolean} options.useVertexColors - Use vertex colors from mesh (default: false)
	 * @param {boolean} options.showCoverslip - Show the coverslip slab under the cell (default: true)
	 * @param {number} options.coverslipSize - Square footprint of the coverslip in mesh units
	 *   (default: 200; in absolute mode the default follows the scene bounds instead)
	 * @param {number} options.coverslipScale - Absolute mode only: coverslip footprint relative to the
	 *   scene footprint (default: 1.25); ignored when coverslipSize is given
	 * @param {number} options.axesSize - Size of the orientation marker in pixels (default: 120)
	 *
	 * The default camera distance is divided by the `--viewer-zoom` CSS custom property
	 * of the view element (default 1; > 1 moves the camera closer), so a stylesheet can
	 * set it per view and per media query.
	 * @param {number} options.coverslipThickness - Coverslip thickness in mesh units (default: 12)
	 * @param {number} options.coverslipOpacity - Opacity of the coverslip body (default: 0.5)
	 * @param {Function} options.onLoadProgress - Callback for load progress (loaded, total)
	 * @param {Function} options.onLoadComplete - Callback when all meshes loaded
	 * @param {Function} options.onFrameChange - Callback when frame changes (index)
	 * @param {Function} options.onCountResolved - Callback once the frame count is known (count, startIndex)
	 */
	constructor(options) {
		this.elem = options.elem;
		this.centerFrames = options.centerFrames !== false;
		this.sceneRotation = THREE.MathUtils.degToRad(Number(options.sceneRotation) || 0);
		this.padWidth = options.padWidth || 4;
		this.fileExtension = options.fileExtension || '.glb';
		this.loadConcurrency = options.loadConcurrency || 12;
		this.defaultPlaySpeed = options.defaultPlaySpeed || 250;
		this.enableControls = options.enableControls !== false;
		this.useVertexColors = options.useVertexColors || false;
		this.showCoverslip = options.showCoverslip !== false;
		// null = size the slab from the scene (absolute mode) or the default pad (centred mode)
		this.coverslipSize = Number.isFinite(options.coverslipSize) ? options.coverslipSize : null;
		this.coverslipScale = positiveOr(options.coverslipScale, COVERSLIP.footprintScale);
		this.axesSize = positiveOr(options.axesSize, undefined);
		this.coverslipThickness = options.coverslipThickness ?? COVERSLIP.thickness;
		this.coverslipOpacity = options.coverslipOpacity ?? COVERSLIP.meshBodyOpacity;

		// Callbacks
		this.onLoadProgress = options.onLoadProgress || (() => {});
		this.onLoadComplete = options.onLoadComplete || (() => {});
		this.onFrameChange = options.onFrameChange || (() => {});
		this.onCountResolved = options.onCountResolved || (() => {});

		// State: the sequences carry their own meshes and bounds; meshCount is the
		// playback length (the longest sequence) once every sequence is resolved
		this.sequences = this._makeSequences(options);
		this.meshCount = 0;
		this.currentIndex = 0;
		this.isPlaying = false;
		this.playTimeoutId = null;
		this.playSpeed = this.defaultPlaySpeed;
		this.loadedCount = 0;
		this.isDisposed = false;
		// Incremented by setDataset() so loads still in flight for a previous dataset
		// can recognise they are stale and discard their results.
		this.loadGeneration = 0;
		// Bounds the coverslip is seated on: the first frame (centred mode) or the union
		// of the sequence bounds (absolute mode, also used to fit the camera)
		this.sceneBounds = null;
		// Set once the user orbits / zooms; until then the camera follows the fit on resize
		this.cameraTouched = false;

		// Three.js objects
		this.scene = null;
		this.camera = null;
		this.controls = null;
		this.surfaceMaterial = null;
		this.sceneRoot = null;
		this.frameRoot = null;
		this.coverslip = null;
		this.orientationMarker = null;
		// Point the camera orbits and looks at (the origin in centred mode); shared
		// with the controls so the two never need syncing
		this.target = new THREE.Vector3();

		this._init();
	}

	/**
	 * Build the per-sequence state objects from the constructor / setDataset options
	 * @private
	 * @param {Object} options - `{ sequences }` or `{ basePath, meshCount, startIndex }`
	 * @returns {Object[]}
	 */
	_makeSequences(options) {
		const specs = Array.isArray(options.sequences) && options.sequences.length > 0
			? options.sequences
			: [{ basePath: options.basePath, meshCount: options.meshCount, startIndex: options.startIndex }];
		return specs.map((spec) => {
			// An explicit count skips discovery; anything else means "ask the server"
			const explicitCount = Number(spec.meshCount);
			const seq = {
				basePath: spec.basePath,
				meshCount: Number.isFinite(explicitCount) && explicitCount > 0 ? Math.floor(explicitCount) : 0,
				startIndex: Number.isInteger(spec.startIndex) ? spec.startIndex : null,
				meshes: [],
				frameBounds: []
			};
			// Resolves with the first frame's Box3 (or null if it never loads); used
			// to fit the scene when a sequence ships no metadata.json
			seq.firstFrameBounds = new Promise((resolve) => { seq._resolveFirstFrame = resolve; });
			return seq;
		});
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
		this.camera.position.set(0, 0, DEFAULT_CAMERA_DISTANCE / this._cssZoom());
		this.camera.up.set(0, 1, 0);
		this.camera.lookAt(this.target);

		// One surface material shared by every frame (napari-style shading + baked AO)
		this.surfaceMaterial = createSurfaceMaterial({ useVertexColors: this.useVertexColors });

		// Meshes and coverslip live under one group that applies the scene rotation,
		// so the data can be turned to fit the view without touching the camera presets
		this.sceneRoot = new THREE.Group();
		this.sceneRoot.name = 'sceneRoot';
		this.sceneRoot.rotation.z = this.sceneRotation;
		this.scene.add(this.sceneRoot);

		// Coverslip slab, seated under the first frame once its bounds are known. In
		// absolute mode the slab is sized from the scene bounds, so it is built then.
		if (this.centerFrames) {
			const size = this.coverslipSize ?? COVERSLIP.padSize;
			this._buildCoverslip(size, size);
		}

		// Every frame is parented here. In centred mode the group is translated once,
		// when the first frame loads, so that frame is centred over the coverslip in
		// XY; because the same translation applies to all frames the registration
		// between them is kept. In absolute mode it stays at the origin.
		this.frameRoot = new THREE.Group();
		this.frameRoot.name = 'frames';
		this.sceneRoot.add(this.frameRoot);

		// Create controls (scoped to the view element)
		if (this.enableControls) {
			// TrackballControls allow free rotation in any direction
			this.controls = new TrackballControls(this.camera, this.elem);
			this.controls.rotateSpeed = 2.0;
			this.controls.zoomSpeed = 1.2;
			this.controls.panSpeed = 0.8;
			this.controls.staticMoving = false;
			this.controls.dynamicDampingFactor = 0.6;
			this.controls.target = this.target;
			this.controls.addEventListener('start', () => { this.cameraTouched = true; });
		}

		// Create orientation marker
		this.orientationMarker = new OrientationMarker({ size: this.axesSize });

		// Register with shared renderer
		sharedRenderer.addView(this);

		// Resolve the mesh counts (explicit or discovered), then load
		this._start();
	}

	/**
	 * (Re)create the coverslip slab with a given footprint; it starts hidden
	 * @private
	 * @param {number} sizeX
	 * @param {number} sizeY
	 */
	_buildCoverslip(sizeX, sizeY) {
		if (this.coverslip) this.coverslip.dispose();
		this.coverslip = new Coverslip({
			sizeX,
			sizeY,
			thickness: this.coverslipThickness,
			edgeColor: COVERSLIP.edgeColorLight,
			bodyOpacity: this.coverslipOpacity
		});
		this.coverslip.setVisible(false);
		this.sceneRoot.add(this.coverslip.group);
	}

	/**
	 * Zoom factor from the view element's `--viewer-zoom` CSS custom property (default 1)
	 * @private
	 * @returns {number}
	 */
	_cssZoom() {
		return positiveOr(parseFloat(getComputedStyle(this.elem).getPropertyValue('--viewer-zoom')), 1);
	}

	/**
	 * Resolve every sequence's mesh count (explicit option or server discovery),
	 * then start loading
	 * @private
	 */
	async _start() {
		const generation = this.loadGeneration;
		try {
			// Absolute mode: fit the coverslip and camera as soon as the scene bounds
			// are known (metadata.json, else the first frames); runs alongside discovery
			if (!this.centerFrames) this._resolveSceneBounds(generation);

			await Promise.all(this.sequences.map((seq) => this._resolveSequence(seq)));
			if (this._isStale(generation)) return;

			this.meshCount = Math.max(0, ...this.sequences.map((seq) => seq.meshCount));
			const summary = this.sequences
				.map((seq) => `${seq.meshCount} meshes at ${seq.basePath} (start index ${seq.startIndex})`)
				.join('; ');
			console.log(`MeshTimeseriesView: ${summary}`);
			this.onCountResolved(this.meshCount, this.sequences[0].startIndex);

			if (this.meshCount === 0) {
				const example = this._urlFor(this.sequences[0], this.sequences[0].startIndex ?? 1);
				console.warn(`MeshTimeseriesView: no mesh files found, expected e.g. ${example}`);
				this.onLoadComplete();
				return;
			}

			this._loadAllMeshes();
		} catch (error) {
			console.error('MeshTimeseriesView: failed to resolve mesh files:', error);
		}
	}

	/**
	 * Fill in one sequence's numbering origin and count
	 * @private
	 * @param {Object} seq
	 */
	async _resolveSequence(seq) {
		if (seq.meshCount > 0) {
			// Explicit count: only the numbering origin needs detecting
			if (seq.startIndex === null) {
				const detected = await this._detectStartIndex(seq);
				seq.startIndex = detected ?? 1;
			}
		} else {
			const { startIndex, count } = await this._discoverMeshRange(seq);
			seq.startIndex = startIndex;
			seq.meshCount = count;
		}
		// Nothing will ever load for an empty sequence
		if (seq.meshCount === 0) seq._resolveFirstFrame(null);
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
	 * Swap the mesh sequence(s) shown by this view while keeping the scene, camera,
	 * controls and lights. The frame resets to 0; camera orientation is preserved.
	 * @param {Object} options
	 * @param {string} [options.basePath] - New file prefix (e.g. 'data/meshes2/mesh')
	 * @param {number} [options.meshCount] - Explicit count; omit to discover from the server
	 * @param {number} [options.startIndex] - Explicit numbering origin; omit to detect
	 * @param {Object[]} [options.sequences] - Several sequences rendered together (see constructor)
	 * @param {boolean} [options.useVertexColors] - Defaults to the current setting
	 */
	setDataset(options = {}) {
		if (this.isDisposed) return;
		this.pause();
		this.loadGeneration++;

		this._disposeMeshes();

		this.sequences = this._makeSequences({ ...options, basePath: options.basePath ?? this.getBasePath() });
		this.meshCount = 0;
		if (typeof options.useVertexColors === 'boolean') {
			this.useVertexColors = options.useVertexColors;
		}
		setUseVertexColors(this.surfaceMaterial, this.useVertexColors);
		if (this.coverslip) this.coverslip.setVisible(false);
		if (this.frameRoot) this.frameRoot.position.set(0, 0, 0);
		this.sceneBounds = null;
		this.currentIndex = 0;
		this.loadedCount = 0;

		this.onFrameChange(0, false);
		this._start();
	}

	/**
	 * Get the file prefix of the (first) dataset currently shown
	 * @returns {string}
	 */
	getBasePath() {
		return this.sequences[0]?.basePath;
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
		for (const seq of this.sequences) {
			for (const mesh of seq.meshes) {
				if (mesh) {
					this._disposeObject(mesh);
					if (mesh.parent) mesh.parent.remove(mesh);
				}
			}
			seq.meshes = [];
			seq.frameBounds = [];
		}
	}

	/**
	 * Build the URL of one mesh file
	 * @private
	 * @param {Object} seq
	 * @param {number} index - File index (not frame index)
	 * @returns {string}
	 */
	_urlFor(seq, index) {
		return `${seq.basePath}${String(index).padStart(this.padWidth, '0')}${this.fileExtension}`;
	}

	/**
	 * Check whether a mesh file exists on the server without downloading it
	 * @private
	 * @param {Object} seq
	 * @param {number} index - File index
	 * @returns {Promise<boolean>}
	 */
	async _probeExists(seq, index) {
		const url = this._urlFor(seq, index);
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
	 * Detect whether a sequence starts at index 0 or 1
	 * @private
	 * @param {Object} seq
	 * @returns {Promise<number|null>} 0 or 1, or null if neither file exists
	 */
	async _detectStartIndex(seq) {
		const [hasZero, hasOne] = await Promise.all([this._probeExists(seq, 0), this._probeExists(seq, 1)]);
		if (hasZero) return 0;
		if (hasOne) return 1;
		return null;
	}

	/**
	 * Discover the numbering origin and the number of contiguous mesh files,
	 * sharing the result with other views of the same sequence
	 * @private
	 * @param {Object} seq
	 * @returns {Promise<{startIndex: number, count: number}>}
	 */
	_discoverMeshRange(seq) {
		const key = `${seq.basePath}|${this.fileExtension}|${this.padWidth}|${seq.startIndex ?? 'auto'}`;
		if (!discoveryCache.has(key)) {
			const discovery = this._probeMeshRange(seq).catch((error) => {
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
	 * @param {Object} seq
	 * @returns {Promise<{startIndex: number, count: number}>}
	 */
	async _probeMeshRange(seq) {
		// 1. Numbering origin
		let startIndex = seq.startIndex;
		if (startIndex === null) {
			startIndex = await this._detectStartIndex(seq);
			if (startIndex === null) return { startIndex: 1, count: 0 };
		} else if (!(await this._probeExists(seq, startIndex))) {
			return { startIndex, count: 0 };
		}

		// 2. Galloping search for the first missing index
		const offsets = [];
		for (let offset = 1; offset <= MAX_PROBE_OFFSET; offset *= 2) offsets.push(offset);
		let lo = startIndex; // last index known to exist
		let hi = null;       // first index known to be missing
		for (let c = 0; c < offsets.length && hi === null; c += PROBE_FANOUT) {
			const chunk = offsets.slice(c, c + PROBE_FANOUT);
			const hits = await Promise.all(chunk.map((offset) => this._probeExists(seq, startIndex + offset)));
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
			const hits = await Promise.all(points.map((point) => this._probeExists(seq, point)));
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
	 * Load every mesh of every sequence with concurrency control. Files are queued
	 * frame-major (frame 0 of each sequence first) so the first frame of the whole
	 * scene appears as early as possible.
	 * @private
	 */
	_loadAllMeshes() {
		const generation = this.loadGeneration;
		const loader = sharedRenderer.getLoader();

		const jobs = [];
		for (let i = 0; i < this.meshCount; i++) {
			for (const seq of this.sequences) {
				if (i < seq.meshCount) {
					jobs.push({ seq, index: i, url: this._urlFor(seq, (seq.startIndex ?? 1) + i) });
				}
			}
		}
		const total = jobs.length;

		let activeLoads = 0;
		let nextJob = 0;
		let settledCount = 0;

		// Runs after every load, successful or not, so completion fires even when
		// some files are missing (an over-estimated explicit count, a bad file, ...)
		const onSettled = () => {
			settledCount++;
			activeLoads--;
			if (settledCount === total && !this._isStale(generation)) {
				this.onLoadComplete();
			}
			loadNext();
		};

		const loadNext = () => {
			if (this._isStale(generation)) return;

			while (activeLoads < this.loadConcurrency && nextJob < total) {
				const job = jobs[nextJob++];
				activeLoads++;

				loader.loadAsync(job.url)
					.then((gltf) => {
						if (this._isStale(generation)) {
							// The view was disposed or switched dataset while this file was loading
							this._disposeObject(gltf.scene);
							return;
						}

						this._addFrame(job.seq, job.index, gltf.scene);
						this.loadedCount++;
						this.onLoadProgress(this.loadedCount, total);
						onSettled();
					})
					.catch((error) => {
						console.error(`Error loading ${job.url}:`, error);
						if (job.index === 0) job.seq._resolveFirstFrame(null);
						onSettled();
					});
			}
		};

		this.onLoadProgress(0, total);
		loadNext();
	}

	/**
	 * Register one loaded frame of a sequence: shade it, record its bounds, place it
	 * in the frame group and show it if it is the current frame
	 * @private
	 * @param {Object} seq
	 * @param {number} index - Frame index
	 * @param {THREE.Object3D} object - Loaded GLTF scene
	 */
	_addFrame(seq, index, object) {
		applySurfaceMaterial(object, this.surfaceMaterial);
		// Bounds in the frame group's space (the GLBs of a sequence share one origin)
		object.updateMatrixWorld(true);
		const bounds = new THREE.Box3().setFromObject(object);
		seq.frameBounds[index] = bounds;

		if (index === 0) {
			seq._resolveFirstFrame(bounds);
			// Centred mode: the first sequence's first frame defines the XY shift and
			// seats the coverslip
			if (this.centerFrames && seq === this.sequences[0]) this._centerFirstFrame();
		}

		object.visible = index === this.currentIndex;
		this.frameRoot.add(object);
		seq.meshes[index] = object;

		// The frame on screen just gained a mesh: let the UI drop its "loading" marker
		if (index === this.currentIndex) {
			this.onFrameChange(index, this.isFrameLoaded(index));
		}
	}

	/**
	 * Set the visible frame: file `index` of every sequence that has one
	 * @param {number} index - Frame index to show
	 */
	setFrame(index) {
		if (index < 0 || index >= this.meshCount) return;

		const previous = this.currentIndex;
		this.currentIndex = index;
		for (const seq of this.sequences) {
			if (seq.meshes[previous]) seq.meshes[previous].visible = false;
			if (seq.meshes[index]) seq.meshes[index].visible = true;
		}

		this.onFrameChange(index, this.isFrameLoaded(index));
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
		const bounds = this.sequences[0]?.frameBounds[0];
		if (!bounds) return;

		// The group's Z is untouched, so bounds.min.z is also the world-space floor
		const center = bounds.getCenter(new THREE.Vector3());
		this.frameRoot.position.set(-center.x, -center.y, 0);
		this.sceneBounds = bounds;

		this._seatCoverslip();
	}

	/**
	 * Place the coverslip so its top face touches the lowest point of the first frame
	 * @private
	 */
	_seatCoverslip() {
		if (!this.coverslip || !this.showCoverslip) return;
		const bounds = this.sequences[0]?.frameBounds[0];
		if (!bounds) return;
		this.coverslip.setTop(bounds.min.z + this.frameRoot.position.z);
		this.coverslip.setVisible(true);
	}

	/**
	 * Absolute mode: gather the bounds of every sequence (its metadata.json when
	 * available, otherwise its first frame) and fit the coverslip and camera to
	 * their union
	 * @private
	 * @param {number} generation
	 */
	async _resolveSceneBounds(generation) {
		const boxes = await Promise.all(this.sequences.map(async (seq) => {
			const fromMetadata = await this._fetchSequenceBounds(seq);
			return fromMetadata ?? (await seq.firstFrameBounds);
		}));
		if (this._isStale(generation)) return;

		const union = new THREE.Box3();
		for (const box of boxes) {
			if (box) union.union(box);
		}
		if (union.isEmpty()) return;
		this.sceneBounds = union;
		this._seatSceneCoverslip(union);
		this._fitCamera();
	}

	/**
	 * Read the whole-sequence bounds written by scripts/ply_to_glb.py to
	 * `<folder>/metadata.json`, if that file exists next to the meshes
	 * @private
	 * @param {Object} seq
	 * @returns {Promise<THREE.Box3|null>}
	 */
	async _fetchSequenceBounds(seq) {
		const slash = seq.basePath.lastIndexOf('/');
		if (slash === -1) return null;
		const url = `${seq.basePath.slice(0, slash + 1)}metadata.json`;
		try {
			const response = await fetch(url);
			const type = response.headers.get('content-type') || '';
			if (!response.ok || type.includes('text/html')) return null;
			const metadata = await response.json();
			const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
			const min = metadata?.bounds?.min;
			const max = metadata?.bounds?.max;
			if (!isVec3(min) || !isVec3(max)) return null;
			return new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
		} catch (error) {
			return null;
		}
	}

	/**
	 * Absolute mode: build a coverslip sized to the scene footprint (unless a size
	 * was given) and seat it under the scene's lowest point
	 * @private
	 * @param {THREE.Box3} bounds - Scene bounds in frame-group space (before the scene rotation)
	 */
	_seatSceneCoverslip(bounds) {
		const center = bounds.getCenter(new THREE.Vector3());
		const size = bounds.getSize(new THREE.Vector3());
		const sizeX = this.coverslipSize ?? size.x * this.coverslipScale;
		const sizeY = this.coverslipSize ?? size.y * this.coverslipScale;
		this._buildCoverslip(sizeX, sizeY);
		this.coverslip.setCenterXY(center.x, center.y);
		this.coverslip.setTop(bounds.min.z);
		this.coverslip.setVisible(this.showCoverslip);
	}

	/**
	 * Absolute mode: point the camera at the scene centre (in world space, i.e.
	 * after the scene rotation) from the current direction, far enough for the
	 * cells and the slab to fill the view, divided by the CSS `--viewer-zoom`
	 * @private
	 */
	_fitCamera() {
		const bounds = this.sceneBounds;
		if (!bounds) return;

		// Moving the pivot and the camera by the same offset keeps the camera's
		// orientation, so the fit below can use its current quaternion
		const direction = this.camera.position.clone().sub(this.target);
		if (direction.lengthSq() === 0) direction.set(0, 0, 1);
		direction.normalize();
		this.sceneRoot.updateWorldMatrix(true, false);
		this.target.copy(bounds.getCenter(new THREE.Vector3())).applyMatrix4(this.sceneRoot.matrixWorld);

		// Fit box: the scene plus the coverslip (local space, before rotation)
		const fitBox = bounds.clone();
		if (this.coverslip && this.showCoverslip) {
			fitBox.union(new THREE.Box3().setFromCenterAndSize(
				this.coverslip.group.position,
				new THREE.Vector3(this.coverslip.sizeX, this.coverslip.sizeY, this.coverslip.thickness)
			));
		}
		const distance = this._fitDistance(fitBox, this.sceneRoot.matrixWorld) / this._cssZoom();
		this.camera.position.copy(this.target).addScaledVector(direction, distance);
		this.camera.lookAt(this.target);
		if (this.controls) this.controls.update();
	}

	/**
	 * Called by the shared renderer when the view's aspect ratio changes (window
	 * resize, phone rotation). In absolute mode the fit depends on the aspect, so
	 * redo it as long as the user has not taken over the camera.
	 */
	onViewResized() {
		if (this.centerFrames || this.cameraTouched || this.isDisposed) return;
		this._fitCamera();
	}

	/**
	 * Camera distance from the target at which a box just fits the view from the
	 * camera's current orientation: the box corners are measured in camera space
	 * (sideways, up and toward the camera) and the tighter of the horizontal and
	 * vertical fields of view decides
	 * @private
	 * @param {THREE.Box3} box - Box to fit, in the space `boxToWorld` maps from
	 * @param {THREE.Matrix4} boxToWorld - Transform of the box's space into world space
	 * @returns {number}
	 */
	_fitDistance(box, boxToWorld) {
		// The shared renderer keeps camera.aspect in step with the view element
		const vFov = THREE.MathUtils.degToRad(this.camera.fov);
		const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);

		// Camera basis: x right, y up, z toward the camera
		const toCamera = this.camera.quaternion.clone().invert();
		let halfWidth = 0;
		let halfHeight = 0;
		let depth = 0;
		const corner = new THREE.Vector3();
		for (let i = 0; i < 8; i++) {
			corner.set(
				i & 1 ? box.max.x : box.min.x,
				i & 2 ? box.max.y : box.min.y,
				i & 4 ? box.max.z : box.min.z
			);
			corner.applyMatrix4(boxToWorld).sub(this.target).applyQuaternion(toCamera);
			halfWidth = Math.max(halfWidth, Math.abs(corner.x));
			halfHeight = Math.max(halfHeight, Math.abs(corner.y));
			depth = Math.max(depth, corner.z);
		}

		const fitWidth = halfWidth / Math.tan(hFov / 2);
		const fitHeight = halfHeight / Math.tan(vFov / 2);
		return Math.max(fitWidth, fitHeight) * FIT_PADDING + depth;
	}

	/**
	 * Show or hide the coverslip slab
	 * @param {boolean} visible
	 */
	setCoverslipVisible(visible) {
		this.showCoverslip = visible;
		if (this.coverslip) this.coverslip.setVisible(visible && !!this.sceneBounds);
	}

	/**
	 * Get current frame index
	 * @returns {number}
	 */
	getFrame() {
		return this.currentIndex;
	}

	/**
	 * Check if a frame is fully loaded: every sequence that has this frame has it in memory
	 * @param {number} index - Frame index
	 * @returns {boolean}
	 */
	isFrameLoaded(index) {
		let anySequence = false;
		for (const seq of this.sequences) {
			if (index >= seq.meshCount) continue;
			anySequence = true;
			if (!seq.meshes[index]) return false;
		}
		return anySequence;
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

		// Preserve current zoom distance (from the orbit target)
		const distance = this.camera.position.distanceTo(this.target);

		// Calculate target position (normalized direction * distance, around the target)
		const targetPos = new THREE.Vector3(...preset.pos).normalize().multiplyScalar(distance).add(this.target);
		const targetUp = new THREE.Vector3(...preset.up);

		this._animateCameraTo(targetPos, targetUp);
	}

	/**
	 * Animate camera to target position with smooth transition, orbiting the view target
	 * @param {THREE.Vector3} targetPosition - Target camera position
	 * @param {THREE.Vector3} targetUp - Target up vector
	 * @private
	 */
	_animateCameraTo(targetPosition, targetUp) {
		const duration = 700; // ms
		const startTime = performance.now();

		// Start state relative to the orbit pivot (the live target, shared with the controls)
		const pivot = this.target;
		const startOffset = this.camera.position.clone().sub(pivot);
		const startUp = this.camera.up.clone();
		const distance = startOffset.length();

		// Normalize directions for spherical interpolation
		const startDir = startOffset.clone().normalize();
		const endDir = targetPosition.clone().sub(pivot).normalize();

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
			this.camera.position.copy(pivot).addScaledVector(currentDir, distance);

			// Interpolate up vector
			this.camera.up.lerpVectors(startUp, targetUp, eased).normalize();

			// Make camera look at the pivot
			this.camera.lookAt(pivot);

			if (t < 1) {
				requestAnimationFrame(animate);
			} else {
				// Ensure final state is exact
				this.camera.position.copy(targetPosition);
				this.camera.up.copy(targetUp);
				this.camera.lookAt(pivot);

				// Reset controls to pick up new camera state
				if (this.controls) this.controls.update();
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
