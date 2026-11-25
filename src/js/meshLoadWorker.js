import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { computeSmoothNormals } from './SmoothNormals.js';
import { fetchFile } from './fetchFile.js';
import { releaseBuffers } from './releaseBuffers.js';

/**
 * meshLoadWorker - downloads and prepares one mesh frame off the main thread.
 *
 * Messages in:
 *   { type: 'load', id, url }            download the file, then prepare it. url is
 *                                        absolute (a worker resolves relative URLs
 *                                        against its own script, not against the page)
 *   { type: 'decode', id, url, buffer }  prepare a file the main thread already holds
 *   { type: 'cancel', id }
 *
 * Messages out:
 *   { type: 'loaded', id, meshes, bounds }   see describeScene; typed arrays transferred
 *   { type: 'unsupported', id, reason }      the file needs the full loader on the main thread
 *   { type: 'error', id, message }           the download failed or was cancelled
 *
 * Everything that costs time between the network and the GPU happens here: the
 * download itself (served by the browser's HTTP cache when it has the file), glTF
 * parsing, meshopt decoding and the smooth normals. The main thread only wraps the
 * arrays it receives (see buildMeshObject in MeshLoadPool.js).
 */

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

// AbortController of each download in flight, by job id
const controllers = new Map();

/**
 * Flatten a parsed glTF scene into plain data the main thread can rebuild its
 * meshes from: per mesh the attribute arrays, index, bounds and world matrix.
 * @param {THREE.Object3D} scene
 * @returns {{meshes: Object[], bounds: Object|null, transfer: ArrayBuffer[]}|null}
 *   null when the scene holds something this path does not carry over
 */
function describeScene(scene) {
	scene.updateMatrixWorld(true);

	const meshes = [];
	const transfer = new Set();
	let supported = true;

	scene.traverse((child) => {
		if (!supported) return;
		// Only static triangle meshes take this path; they are all the converter writes
		if (child.isLine || child.isPoints || child.isSkinnedMesh || child.isInstancedMesh) {
			supported = false;
			return;
		}
		if (!child.isMesh) return;
		const geometry = child.geometry;
		if (Object.keys(geometry.morphAttributes).length > 0) {
			supported = false;
			return;
		}

		computeSmoothNormals(geometry);

		// Interleaved attributes share a buffer, which is sent once
		const buffers = [];
		const bufferIndex = new Map();
		const attributes = {};
		for (const [name, attribute] of Object.entries(geometry.attributes)) {
			if (attribute.isInterleavedBufferAttribute) {
				if (!bufferIndex.has(attribute.data)) {
					bufferIndex.set(attribute.data, buffers.length);
					buffers.push({ array: attribute.data.array, stride: attribute.data.stride });
					transfer.add(attribute.data.array.buffer);
				}
				attributes[name] = {
					buffer: bufferIndex.get(attribute.data),
					itemSize: attribute.itemSize,
					offset: attribute.offset,
					normalized: attribute.normalized
				};
			} else {
				attributes[name] = { array: attribute.array, itemSize: attribute.itemSize, normalized: attribute.normalized };
				transfer.add(attribute.array.buffer);
			}
		}
		if (geometry.index) transfer.add(geometry.index.array.buffer);

		// The loader takes these from the file's accessor bounds; sending them on
		// spares the main thread a pass over every vertex before the first draw
		const box = geometry.boundingBox;
		const sphere = geometry.boundingSphere;
		meshes.push({
			buffers,
			attributes,
			index: geometry.index ? geometry.index.array : null,
			drawRange: { start: geometry.drawRange.start, count: geometry.drawRange.count },
			box: box ? [...box.min.toArray(), ...box.max.toArray()] : null,
			sphere: sphere ? [...sphere.center.toArray(), sphere.radius] : null,
			matrix: child.matrixWorld.toArray()
		});
	});
	if (!supported) return null;

	// Bounds of the whole frame in the scene's own space, as Box3.setFromObject gives them
	const sceneBox = new THREE.Box3().setFromObject(scene);
	const bounds = sceneBox.isEmpty() ? null : { min: sceneBox.min.toArray(), max: sceneBox.max.toArray() };
	return { meshes, bounds, transfer: Array.from(transfer) };
}

/**
 * Parse one mesh file and post the result. A file this worker cannot parse or
 * carry over is not an error yet: the main thread tries it with the full loader
 * and reports what that says.
 * @param {number} id - Job id
 * @param {ArrayBuffer} buffer - The file's bytes
 * @param {string} url - Where the file came from, for any resources it refers to
 */
async function prepare(id, buffer, url) {
	let frame = null;
	let reason = 'the scene holds more than static triangle meshes';
	try {
		const gltf = await loader.parseAsync(buffer, THREE.LoaderUtils.extractUrlBase(url));
		frame = describeScene(gltf.scene);
	} catch (error) {
		reason = String(error?.message || error);
	}
	// The file itself is not needed any more: the loader copied what it kept
	releaseBuffers([buffer]);
	if (frame) {
		try {
			self.postMessage({ type: 'loaded', id, meshes: frame.meshes, bounds: frame.bounds }, frame.transfer);
			return;
		} catch (error) {
			// Arrays that cannot be transferred (nothing has been sent in that case)
			reason = String(error?.message || error);
		}
	}
	self.postMessage({ type: 'unsupported', id, reason });
}

async function load(id, url) {
	const controller = new AbortController();
	controllers.set(id, controller);
	try {
		await prepare(id, await fetchFile(url, controller.signal), url);
	} catch (error) {
		self.postMessage({ type: 'error', id, message: String(error?.message || error) });
	} finally {
		controllers.delete(id);
	}
}

self.onmessage = (event) => {
	const msg = event.data;
	if (msg.type === 'load') {
		load(msg.id, msg.url);
	} else if (msg.type === 'decode') {
		prepare(msg.id, msg.buffer, msg.url).catch((error) => {
			self.postMessage({ type: 'error', id: msg.id, message: String(error?.message || error) });
		});
	} else if (msg.type === 'cancel') {
		const controller = controllers.get(msg.id);
		if (controller) controller.abort();
	}
};
