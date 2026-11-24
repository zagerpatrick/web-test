import * as THREE from 'three';

/**
 * Smooth vertex normals for the mesh views.
 *
 * The GLBs carry positions and colours only. Normals are rebuilt here when a frame
 * is loaded: by the mesh load workers (meshLoadWorker.js), or on the main thread
 * when a file takes the general path (MaterialFactory.js).
 */

// Working memory of computeSmoothNormals, kept between calls and grown on demand.
// A timeseries runs the routine once per frame on meshes of similar size, so
// reusing the arrays spares several MB of allocation and zero-filling per frame.
let scratchCanonical = new Int32Array(0);
let scratchTable = new Int32Array(0);
let scratchAccum = new Float32Array(0);

// Bit pattern of a float coordinate, for hashing
const floatValue = new Float64Array(1);
const floatWords = new Int32Array(floatValue.buffer);

/**
 * Give a geometry smooth vertex normals even when its vertices are duplicated per
 * face (as in the per-face expanded GLBs): vertices sharing a position share one
 * accumulated, area-weighted normal, so shading is continuous across label
 * boundaries. Geometries that already carry normals are left alone.
 *
 * This runs for every frame of every mesh sequence, each time a dataset is loaded
 * (the browser caches the files, not this result), so it works on the raw arrays
 * instead of going through the attribute accessors.
 * @param {THREE.BufferGeometry} geometry
 */
export function computeSmoothNormals(geometry) {
	if (geometry.attributes.normal) return;
	const position = geometry.attributes.position;
	if (!position) return;
	const count = position.count;

	// Where the coordinates are stored: a plain attribute, or one view of an
	// interleaved buffer (quantized GLBs pad their positions to 4 components).
	// The stored values are used as they are: a normalised attribute only rescales
	// them, which changes neither which positions coincide nor the direction of a normal.
	const interleaved = position.isInterleavedBufferAttribute === true;
	const coords = interleaved ? position.data.array : position.array;
	const stride = interleaved ? position.data.stride : position.itemSize;
	const offset = interleaved ? position.offset : 0;
	const floatCoords = coords instanceof Float32Array || coords instanceof Float64Array;

	// 1. Canonical id per distinct position, through an open-addressing hash table
	//    of vertex numbers (stored + 1, so 0 marks a free slot)
	let tableSize = 1024;
	while (tableSize < count * 2) tableSize *= 2;
	if (scratchTable.length < tableSize) scratchTable = new Int32Array(tableSize);
	if (scratchCanonical.length < count) scratchCanonical = new Int32Array(count);
	const table = scratchTable;
	const canonical = scratchCanonical;
	const mask = tableSize - 1;
	table.fill(0, 0, tableSize);

	let distinct = 0;
	for (let i = 0, p = offset; i < count; i++, p += stride) {
		const x = coords[p];
		const y = coords[p + 1];
		const z = coords[p + 2];

		let hx = x;
		let hy = y;
		let hz = z;
		if (floatCoords) {
			// Adding 0 turns -0 into +0, so the two hash alike (they compare equal below)
			floatValue[0] = x + 0;
			hx = floatWords[0] ^ Math.imul(floatWords[1], 0x9e3779b1);
			floatValue[0] = y + 0;
			hy = floatWords[0] ^ Math.imul(floatWords[1], 0x9e3779b1);
			floatValue[0] = z + 0;
			hz = floatWords[0] ^ Math.imul(floatWords[1], 0x9e3779b1);
		}
		let hash = Math.imul(hx, 73856093) ^ Math.imul(hy, 19349663) ^ Math.imul(hz, 83492791);
		hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
		let slot = (hash ^ (hash >>> 13)) & mask;

		for (;;) {
			const entry = table[slot];
			if (entry === 0) {
				table[slot] = i + 1;
				canonical[i] = distinct++;
				break;
			}
			const q = offset + (entry - 1) * stride;
			if (coords[q] === x && coords[q + 1] === y && coords[q + 2] === z) {
				canonical[i] = canonical[entry - 1];
				break;
			}
			slot = (slot + 1) & mask;
		}
	}

	// 2. Accumulate face normals (length = 2 * area) into the canonical slots
	if (scratchAccum.length < distinct * 3) scratchAccum = new Float32Array(distinct * 3);
	const accum = scratchAccum;
	accum.fill(0, 0, distinct * 3);

	const indices = geometry.index ? geometry.index.array : null;
	const cornerCount = Math.floor((geometry.index ? geometry.index.count : count) / 3) * 3;
	for (let t = 0; t < cornerCount; t += 3) {
		const a = indices ? indices[t] : t;
		const b = indices ? indices[t + 1] : t + 1;
		const c = indices ? indices[t + 2] : t + 2;
		const pa = offset + a * stride;
		const pb = offset + b * stride;
		const pc = offset + c * stride;

		// (C - B) x (A - B)
		const bx = coords[pb];
		const by = coords[pb + 1];
		const bz = coords[pb + 2];
		const ux = coords[pc] - bx;
		const uy = coords[pc + 1] - by;
		const uz = coords[pc + 2] - bz;
		const vx = coords[pa] - bx;
		const vy = coords[pa + 1] - by;
		const vz = coords[pa + 2] - bz;
		const nx = uy * vz - uz * vy;
		const ny = uz * vx - ux * vz;
		const nz = ux * vy - uy * vx;

		let k = canonical[a] * 3;
		accum[k] += nx; accum[k + 1] += ny; accum[k + 2] += nz;
		k = canonical[b] * 3;
		accum[k] += nx; accum[k + 1] += ny; accum[k + 2] += nz;
		k = canonical[c] * 3;
		accum[k] += nx; accum[k + 1] += ny; accum[k + 2] += nz;
	}

	// 3. Normalised per-vertex normal from its canonical slot
	const normals = new Float32Array(count * 3);
	for (let i = 0, n = 0; i < count; i++, n += 3) {
		const k = canonical[i] * 3;
		const x = accum[k];
		const y = accum[k + 1];
		const z = accum[k + 2];
		const length = Math.sqrt(x * x + y * y + z * z) || 1;
		normals[n] = x / length;
		normals[n + 1] = y / length;
		normals[n + 2] = z / length;
	}
	geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
}
