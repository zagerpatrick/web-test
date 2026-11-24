import * as THREE from 'three';

/**
 * MeshLoadPool - loads mesh frames in Web Workers (module singleton, shared by
 * every MeshTimeseriesView).
 *
 * A mesh frame is cheap to download again, because the browser's HTTP cache keeps
 * the file, but it has to be parsed, meshopt-decoded and given normals every time
 * it is loaded: on a page refresh, and whenever a viewer switches dataset. Done on
 * the main thread that work adds up to seconds per page and holds up everything
 * else on it, such as the volume viewer's loading. The workers do it in parallel
 * instead (see meshLoadWorker.js) and hand back plain arrays.
 *
 * load() resolves to null when a frame has to take the general path on the main
 * thread instead: workers are unavailable or have failed, or the file holds
 * something the workers do not carry over.
 */

const POOL_SIZE = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));

const cancelled = () => new DOMException('The mesh download was cancelled', 'AbortError');

class MeshLoadPool {
	constructor() {
		this.clients = new Set();
		this.workers = [];         // { worker, active } with active = jobs in flight
		this.jobs = new Map();     // id -> { resolve, reject, entry, signal, onAbort, url }
		this.nextId = 1;
		this.disabled = typeof Worker === 'undefined';
	}

	/** Start the workers for the first view, so they are up by the time it has files to load */
	addClient(client) {
		this.clients.add(client);
		if (!this.disabled && this.workers.length === 0) this._start();
	}

	removeClient(client) {
		this.clients.delete(client);
		if (this.clients.size === 0) this._stop();
	}

	/**
	 * Download and prepare one mesh frame
	 * @param {string} url
	 * @param {AbortSignal} [signal] - Cancels the download
	 * @returns {Promise<Object|null>} `{ meshes, bounds }` for buildMeshObject, or null
	 *   when the frame must be loaded on the main thread instead. Rejects when the
	 *   download fails or is cancelled.
	 */
	load(url, signal) {
		if (this.disabled || this.workers.length === 0) return Promise.resolve(null);
		if (signal?.aborted) return Promise.reject(cancelled());

		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			// The least busy worker
			const entry = this.workers.reduce((best, candidate) => (candidate.active < best.active ? candidate : best));
			const onAbort = () => {
				if (!this._take(id)) return;
				entry.worker.postMessage({ type: 'cancel', id });
				reject(cancelled());
			};
			if (signal) signal.addEventListener('abort', onAbort, { once: true });
			this.jobs.set(id, { resolve, reject, entry, signal, onAbort, url });
			entry.active++;
			// Absolute, because a worker resolves relative URLs against its own script
			entry.worker.postMessage({ type: 'load', id, url: new URL(url, document.baseURI).href });
		});
	}

	/** Remove a job from the books; null if it has already settled */
	_take(id) {
		const job = this.jobs.get(id);
		if (!job) return null;
		this.jobs.delete(id);
		job.entry.active--;
		if (job.signal) job.signal.removeEventListener('abort', job.onAbort);
		return job;
	}

	_start() {
		try {
			for (let i = 0; i < POOL_SIZE; i++) {
				const worker = new Worker(new URL('./meshLoadWorker.js', import.meta.url), { type: 'module' });
				worker.onmessage = (event) => this._onMessage(event.data);
				worker.onerror = (event) => this._disable(event.message || 'a worker failed to start or crashed');
				worker.onmessageerror = () => this._disable('a worker message could not be read');
				this.workers.push({ worker, active: 0 });
			}
		} catch (error) {
			this._disable(error?.message || String(error));
		}
	}

	_onMessage(msg) {
		const job = this._take(msg.id);
		if (!job) return; // cancelled in the meantime
		if (msg.type === 'loaded') {
			job.resolve({ meshes: msg.meshes, bounds: msg.bounds });
		} else if (msg.type === 'unsupported') {
			console.debug(`MeshLoadPool: ${job.url} goes to the main-thread loader (${msg.reason})`);
			job.resolve(null);
		} else {
			job.reject(new Error(msg.message));
		}
	}

	/**
	 * Give up on workers for the rest of the page's life. Jobs in flight resolve to
	 * null, so their frames (and every later one) load on the main thread.
	 */
	_disable(reason) {
		if (this.disabled) return;
		this.disabled = true;
		console.warn(`MeshLoadPool: loading meshes on the main thread instead of in workers (${reason})`);
		const jobs = Array.from(this.jobs.keys(), (id) => this._take(id));
		this._terminate();
		for (const job of jobs) job.resolve(null);
	}

	_stop() {
		const jobs = Array.from(this.jobs.keys(), (id) => this._take(id));
		this._terminate();
		for (const job of jobs) job.reject(cancelled());
	}

	_terminate() {
		for (const { worker } of this.workers) worker.terminate();
		this.workers = [];
	}
}

const meshLoadPool = new MeshLoadPool();
export default meshLoadPool;

/**
 * Build the scene object of one frame from what a worker prepared: a group holding
 * one mesh per mesh of the file, each at its place in the file's scene and drawn
 * with the given material. Wraps the received arrays without copying them.
 * @param {Object} frame - `{ meshes }` as resolved by load()
 * @param {THREE.Material} material
 * @returns {THREE.Group}
 */
export function buildMeshObject(frame, material) {
	const root = new THREE.Group();
	for (const part of frame.meshes) {
		const geometry = new THREE.BufferGeometry();
		const buffers = part.buffers.map(({ array, stride }) => new THREE.InterleavedBuffer(array, stride));
		for (const [name, spec] of Object.entries(part.attributes)) {
			geometry.setAttribute(name, spec.buffer !== undefined
				? new THREE.InterleavedBufferAttribute(buffers[spec.buffer], spec.itemSize, spec.offset, spec.normalized)
				: new THREE.BufferAttribute(spec.array, spec.itemSize, spec.normalized));
		}
		if (part.index) geometry.setIndex(new THREE.BufferAttribute(part.index, 1));
		geometry.setDrawRange(part.drawRange.start, part.drawRange.count);
		if (part.box) {
			geometry.boundingBox = new THREE.Box3(
				new THREE.Vector3(part.box[0], part.box[1], part.box[2]),
				new THREE.Vector3(part.box[3], part.box[4], part.box[5])
			);
		}
		if (part.sphere) {
			geometry.boundingSphere = new THREE.Sphere(
				new THREE.Vector3(part.sphere[0], part.sphere[1], part.sphere[2]),
				part.sphere[3]
			);
		}

		// Placed by the world matrix it had in the file's scene, which already
		// combines the transforms of its parent nodes
		const mesh = new THREE.Mesh(geometry, material);
		mesh.matrixAutoUpdate = false;
		mesh.matrix.fromArray(part.matrix);
		mesh.matrixWorldNeedsUpdate = true;
		root.add(mesh);
	}
	return root;
}
