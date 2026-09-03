import * as THREE from 'three';

/**
 * VolumeLoader - fetches, decodes and caches timeseries volume frames.
 *
 * Three tiers, all keyed by frame index:
 *   A. compressed bytes for every frame (fetched eagerly, ~300 KB each)
 *   B. decoded 8-bit voxel arrays, LRU-bounded by maxDecodedFrames (~10 MB each)
 *   C. (owned by the view) one persistent R8 Data3DTexture updated in place
 *
 * Decoding (brotli + nibble unpack) runs in a shared pool of Web Workers so the main
 * thread never blocks. Pending decodes are dispatched nearest-to-target first, so
 * scrubbing simply moves the target and the queue reorders itself.
 */

// ---------------------------------------------------------------------------
// Shared decode worker pool (module singleton, used by every VolumeLoader)
// ---------------------------------------------------------------------------

const POOL_SIZE = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));

class DecodePool {
	constructor() {
		this.clients = new Set();
		this.workers = [];
		this.idle = [];
		this.jobs = new Map(); // worker -> job
		this.roundRobin = 0;
	}

	addClient(loader) {
		this.clients.add(loader);
		if (this.workers.length === 0) this._start();
	}

	removeClient(loader) {
		this.clients.delete(loader);
		if (this.clients.size === 0) this._stop();
	}

	/** Dispatch queued jobs to idle workers. */
	kick() {
		while (this.idle.length > 0) {
			const job = this._nextJob();
			if (!job) return;
			const worker = this.idle.pop();
			this.jobs.set(worker, job);
			// The compressed bytes are copied (not transferred) so tier A keeps them.
			worker.postMessage({
				type: 'decode',
				index: job.index,
				bytes: job.bytes,
				voxelCount: job.voxelCount,
				bitDepth: job.bitDepth,
				valueRange: job.valueRange
			});
		}
	}

	_nextJob() {
		const clients = Array.from(this.clients);
		for (let k = 0; k < clients.length; k++) {
			const client = clients[(this.roundRobin + k) % clients.length];
			const job = client._nextJob();
			if (job) {
				this.roundRobin = (this.roundRobin + k + 1) % clients.length;
				return job;
			}
		}
		return null;
	}

	_brotliUrls() {
		// Resolve against the page URL so a relative Vite base ('./') works on a sub-path.
		const baseUrl = import.meta.env?.BASE_URL || './';
		return {
			jsUrl: new URL(`${baseUrl}brotli_wasm.js`, document.baseURI).href,
			wasmUrl: new URL(`${baseUrl}brotli_wasm_bg.wasm`, document.baseURI).href
		};
	}

	_start() {
		const urls = this._brotliUrls();
		for (let i = 0; i < POOL_SIZE; i++) {
			this._spawn(urls);
		}
	}

	_spawn(urls) {
		const worker = new Worker(new URL('./volumeDecodeWorker.js', import.meta.url), { type: 'module' });
		worker.onmessage = (event) => this._onMessage(worker, event.data);
		worker.onerror = (event) => {
			console.error('VolumeLoader: decode worker crashed:', event.message || event);
			this._failJob(worker, 'worker crashed');
			this._replace(worker, urls);
		};
		worker.onmessageerror = () => {
			this._failJob(worker, 'message could not be deserialized');
			this.idle.push(worker);
			this.kick();
		};
		worker.postMessage({ type: 'init', ...urls });
		this.workers.push(worker);
		this.idle.push(worker);
	}

	_replace(worker, urls) {
		worker.terminate();
		this.workers = this.workers.filter(w => w !== worker);
		this.idle = this.idle.filter(w => w !== worker);
		if (this.clients.size > 0) {
			this._spawn(urls);
			this.kick();
		}
	}

	_failJob(worker, message) {
		const job = this.jobs.get(worker);
		if (!job) return;
		this.jobs.delete(worker);
		job.loader._onDecodeError(job.index, new Error(message));
	}

	_onMessage(worker, msg) {
		if (msg.type === 'ready') return;

		if (msg.type === 'error' && msg.index === undefined) {
			// Init failure: every queued decode on this worker will also report an error.
			console.error('VolumeLoader:', msg.message);
			return;
		}

		const job = this.jobs.get(worker);
		this.jobs.delete(worker);
		this.idle.push(worker);

		if (job) {
			if (msg.type === 'decoded') {
				job.loader._onDecoded(job.index, msg.data);
			} else {
				job.loader._onDecodeError(job.index, new Error(msg.message));
			}
		}
		this.kick();
	}

	_stop() {
		for (const worker of this.workers) worker.terminate();
		this.workers = [];
		this.idle = [];
		this.jobs.clear();
	}
}

const pool = new DecodePool();

// ---------------------------------------------------------------------------
// VolumeLoader
// ---------------------------------------------------------------------------

export default class VolumeLoader {
	/**
	 * @param {Object} options
	 * @param {number} options.fetchConcurrency - Parallel fetches of compressed frames (default: 12)
	 * @param {number} options.maxDecodedFrames - Decoded frames kept in memory (default: 16)
	 */
	constructor(options = {}) {
		this.fetchConcurrency = options.fetchConcurrency || 12;
		this.maxDecodedFrames = options.maxDecodedFrames || 16;

		this.metadata = null;
		this.frameCount = 0;

		// Tier A: compressed bytes per frame
		this.compressed = [];
		this.unfetched = new Set();

		// Tier B: decoded voxel arrays, LRU order (oldest first)
		this.decoded = new Map();
		this.decodedOrder = [];

		// Decode scheduling
		this.pending = new Set();   // requested, not yet decoded (includes in-flight)
		this.inFlight = new Set();  // handed to a worker
		this.targetIndex = 0;
		this.forwardBias = false;
		this.pinnedIndex = -1;

		// Callbacks (set by the owner)
		this.onDecoded = () => {};      // (index, data)
		this.onDecodeError = () => {};  // (index, error)

		this.isDisposed = false;
		this.abortController = null; // cancels in-flight fetches on dispose()
		pool.addClient(this);
	}

	/**
	 * Load volume metadata from JSON file
	 * @param {string} metadataUrl - URL to metadata.json
	 * @returns {Promise<Object>} Volume metadata
	 */
	async loadMetadata(metadataUrl) {
		const response = await fetch(metadataUrl);
		if (!response.ok) {
			throw new Error(`Failed to load ${metadataUrl}: ${response.status} ${response.statusText}`);
		}
		// Vite's dev/preview servers answer missing files with index.html (HTTP 200)
		const contentType = response.headers.get('content-type') || '';
		if (contentType.includes('text/html')) {
			throw new Error(`${metadataUrl} not found (the server returned an HTML page instead)`);
		}
		// Parse from text so a syntax error can name the file and its position
		const text = await response.text();
		try {
			return JSON.parse(text);
		} catch (error) {
			throw new Error(`Invalid JSON in ${metadataUrl}: ${error.message} ` +
				'(check for hand-edit mistakes such as a trailing comma after the last entry)');
		}
	}

	/**
	 * Fetch the compressed bytes of every frame (tier A) with bounded concurrency,
	 * nearest to the current target first. Decodes waiting on a frame start as soon
	 * as its bytes land.
	 * @param {string[]} urls - One URL per frame
	 * @param {Object} metadata - Volume metadata (dimensions, bitDepth, valueRange)
	 * @param {Function} onProgress - (fetched, total)
	 * @param {Function} onComplete - Called once every fetch has settled
	 */
	fetchAll(urls, metadata, onProgress = () => {}, onComplete = () => {}) {
		this.metadata = metadata;
		this.frameCount = urls.length;
		this.compressed = new Array(urls.length);
		this.unfetched = new Set(urls.map((_, i) => i));
		this.abortController = new AbortController();
		const { signal } = this.abortController;

		let active = 0;
		let settled = 0;
		let fetched = 0;

		const loadNext = () => {
			if (this.isDisposed) return;

			while (active < this.fetchConcurrency && this.unfetched.size > 0) {
				const index = this._nearestToTarget(this.unfetched);
				this.unfetched.delete(index);
				active++;

				fetch(urls[index], { signal })
					.then((response) => {
						if (!response.ok) {
							throw new Error(`${response.status} ${response.statusText}`);
						}
						return response.arrayBuffer();
					})
					.then((buffer) => {
						if (this.isDisposed) return;
						this.compressed[index] = new Uint8Array(buffer);
						fetched++;
						onProgress(fetched, urls.length);
						pool.kick();
					})
					.catch((error) => {
						// Aborted fetches are the expected outcome of dispose(), not failures
						if (error?.name === 'AbortError' || this.isDisposed) return;
						console.error(`VolumeLoader: failed to fetch ${urls[index]}:`, error);
						this.pending.delete(index);
					})
					.finally(() => {
						if (this.isDisposed) return;
						active--;
						settled++;
						if (settled === urls.length) onComplete();
						loadNext();
					});
			}
		};

		onProgress(0, urls.length);
		loadNext();
	}

	/**
	 * Create the persistent R8 3D texture for this volume. All sampler parameters are
	 * fixed here so later in-place data updates never trigger a reallocation.
	 * @param {Uint8Array} data - Decoded voxels for the initial frame
	 * @returns {THREE.Data3DTexture}
	 */
	createTexture(data) {
		const [width, height, depth] = this.metadata.dimensions;
		const texture = new THREE.Data3DTexture(data, width, height, depth);
		texture.format = THREE.RedFormat;
		texture.type = THREE.UnsignedByteType;
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;
		texture.wrapS = THREE.ClampToEdgeWrapping;
		texture.wrapT = THREE.ClampToEdgeWrapping;
		texture.wrapR = THREE.ClampToEdgeWrapping;
		texture.generateMipmaps = false;
		texture.unpackAlignment = 1; // width need not be a multiple of 4
		texture.needsUpdate = true;
		return texture;
	}

	/**
	 * Move the scheduling target (the frame the user wants to see).
	 * @param {number} index
	 * @param {Object} options
	 * @param {boolean} options.forwardBias - Prefer frames after the target on ties (playback)
	 * @param {number} options.pruneRadius - Drop queued (not in-flight) decodes farther than this
	 */
	setTarget(index, { forwardBias = false, pruneRadius = Infinity } = {}) {
		this.targetIndex = index;
		this.forwardBias = forwardBias;
		for (const i of this.pending) {
			if (!this.inFlight.has(i) && Math.abs(i - index) > pruneRadius) {
				this.pending.delete(i);
			}
		}
		pool.kick();
	}

	/**
	 * Keep one frame's decoded data resident regardless of LRU order (the frame on screen).
	 * @param {number} index
	 */
	pin(index) {
		this.pinnedIndex = index;
	}

	/**
	 * Ask for a frame to be decoded (no-op if decoded or already queued).
	 * @param {number} index
	 */
	requestDecode(index) {
		if (index < 0 || index >= this.frameCount) return;
		if (this.decoded.has(index) || this.pending.has(index)) return;
		this.pending.add(index);
		pool.kick();
	}

	hasDecoded(index) {
		return this.decoded.has(index);
	}

	/**
	 * @param {number} index
	 * @returns {Uint8Array|null} Decoded voxels, or null if not resident
	 */
	getDecoded(index) {
		const data = this.decoded.get(index);
		if (!data) return null;
		this._touch(index);
		return data;
	}

	getCacheStats() {
		return {
			fetched: this.frameCount - this.unfetched.size,
			decoded: this.decoded.size,
			maxDecoded: this.maxDecodedFrames,
			pending: this.pending.size
		};
	}

	dispose() {
		this.isDisposed = true;
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		pool.removeClient(this);
		this.compressed = [];
		this.unfetched.clear();
		this.decoded.clear();
		this.decodedOrder = [];
		this.pending.clear();
		this.inFlight.clear();
	}

	// ---- internal -------------------------------------------------------------

	_valueRange() {
		if (this.metadata.valueRange) return this.metadata.valueRange;
		return (this.metadata.bitDepth || 8) === 4 ? [0, 15] : [0, 255];
	}

	_nearestToTarget(indices) {
		let best = -1;
		let bestDistance = Infinity;
		for (const i of indices) {
			const d = Math.abs(i - this.targetIndex);
			if (d < bestDistance) {
				bestDistance = d;
				best = i;
			}
		}
		return best;
	}

	/** Called by the pool: pick the most urgent decodable frame, or null. */
	_nextJob() {
		if (this.isDisposed || !this.metadata) return null;

		let best = -1;
		let bestScore = Infinity;
		for (const i of this.pending) {
			if (this.inFlight.has(i) || !this.compressed[i]) continue;
			const d = i - this.targetIndex;
			const score = Math.abs(d) * 2 + (this.forwardBias && d < 0 ? 1 : 0);
			if (score < bestScore) {
				bestScore = score;
				best = i;
			}
		}
		if (best < 0) return null;

		this.inFlight.add(best);
		const [width, height, depth] = this.metadata.dimensions;
		return {
			loader: this,
			index: best,
			bytes: this.compressed[best],
			voxelCount: width * height * depth,
			bitDepth: this.metadata.bitDepth || 8,
			valueRange: this._valueRange()
		};
	}

	_onDecoded(index, data) {
		this.inFlight.delete(index);
		this.pending.delete(index);
		if (this.isDisposed) return;

		this._store(index, data);
		this.onDecoded(index, data);
		this._fillToCapacity();
	}

	_onDecodeError(index, error) {
		this.inFlight.delete(index);
		this.pending.delete(index);
		if (this.isDisposed) return;
		console.error(`VolumeLoader: failed to decode frame ${index}:`, error);
		this.onDecodeError(index, error);
	}

	_store(index, data) {
		if (this.decoded.has(index)) this._removeFromOrder(index);
		while (this.decoded.size >= this.maxDecodedFrames) {
			if (!this._evictOne()) break;
		}
		this.decoded.set(index, data);
		this.decodedOrder.push(index);
	}

	_touch(index) {
		this._removeFromOrder(index);
		this.decodedOrder.push(index);
	}

	_removeFromOrder(index) {
		const at = this.decodedOrder.indexOf(index);
		if (at !== -1) this.decodedOrder.splice(at, 1);
	}

	/** Evict the least recently used frame that is neither on screen nor the target. */
	_evictOne() {
		for (let k = 0; k < this.decodedOrder.length; k++) {
			const i = this.decodedOrder[k];
			if (i === this.pinnedIndex || i === this.targetIndex) continue;
			this.decodedOrder.splice(k, 1);
			this.decoded.delete(i);
			return true;
		}
		return false;
	}

	/** Use idle capacity to decode the next-nearest frame until the cache is full. */
	_fillToCapacity() {
		if (this.decoded.size + this.pending.size >= this.maxDecodedFrames) return;
		let best = -1;
		let bestDistance = Infinity;
		for (let i = 0; i < this.frameCount; i++) {
			if (this.decoded.has(i) || this.pending.has(i)) continue;
			const d = Math.abs(i - this.targetIndex);
			if (d < bestDistance) {
				bestDistance = d;
				best = i;
			}
		}
		if (best >= 0) this.requestDecode(best);
	}
}
