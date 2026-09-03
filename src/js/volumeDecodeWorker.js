/**
 * volumeDecodeWorker - decodes one volume frame off the main thread.
 *
 * Messages in:
 *   { type: 'init', jsUrl, wasmUrl }   absolute URLs of brotli_wasm.js / brotli_wasm_bg.wasm
 *   { type: 'decode', index, bytes, voxelCount, bitDepth, valueRange }
 *
 * Messages out:
 *   { type: 'ready' }
 *   { type: 'decoded', index, data }   data: Uint8Array(voxelCount), 0..255, transferred
 *   { type: 'error', index?, message }
 *
 * Output voxels are 8-bit normalized (value - min) / (max - min) * 255, ready for an
 * R8 Data3DTexture. 4-bit input (two voxels per byte, high nibble first) is unpacked here.
 */

let brotli = null;
let initPromise = null;

function initBrotli(jsUrl, wasmUrl) {
	if (!initPromise) {
		initPromise = (async () => {
			// Workers have no document.baseURI, so the main thread resolves the URLs.
			const mod = await import(/* @vite-ignore */ jsUrl);
			await mod.default(wasmUrl);
			brotli = mod;
		})();
	}
	return initPromise;
}

function buildLut(bitDepth, valueRange) {
	const levels = bitDepth === 4 ? 16 : 256;
	const [minVal, maxVal] = valueRange || [0, levels - 1];
	const range = (maxVal - minVal) || 1;
	const lut = new Uint8Array(levels);
	for (let v = 0; v < levels; v++) {
		lut[v] = Math.max(0, Math.min(255, Math.round(255 * (v - minVal) / range)));
	}
	return lut;
}

function unpack(raw, voxelCount, bitDepth, valueRange) {
	const lut = buildLut(bitDepth, valueRange);

	if (bitDepth === 4) {
		const out = new Uint8Array(voxelCount);
		const pairs = voxelCount >> 1;
		for (let i = 0, j = 0; i < pairs; i++) {
			const b = raw[i];
			out[j++] = lut[b >> 4];
			out[j++] = lut[b & 0x0f];
		}
		if (voxelCount & 1) {
			out[voxelCount - 1] = lut[raw[pairs] >> 4];
		}
		return out;
	}

	// 8-bit: identity mapping can hand the decompressed buffer back as-is.
	let identity = true;
	for (let v = 0; v < 256 && identity; v++) identity = lut[v] === v;
	if (identity) return raw;

	const out = new Uint8Array(voxelCount);
	for (let i = 0; i < voxelCount; i++) out[i] = lut[raw[i]];
	return out;
}

self.onmessage = async (event) => {
	const msg = event.data;

	if (msg.type === 'init') {
		try {
			await initBrotli(msg.jsUrl, msg.wasmUrl);
			self.postMessage({ type: 'ready' });
		} catch (err) {
			self.postMessage({ type: 'error', message: `brotli init failed: ${err?.message || err}` });
		}
		return;
	}

	if (msg.type === 'decode') {
		try {
			if (!initPromise) throw new Error('worker used before init');
			await initPromise;

			const { index, voxelCount, bitDepth, valueRange } = msg;
			const expectedBytes = bitDepth === 4 ? Math.ceil(voxelCount / 2) : voxelCount;

			// Brotli has no magic bytes; a payload already at the raw size is uncompressed.
			let raw = msg.bytes;
			if (raw.length !== expectedBytes) {
				raw = brotli.decompress(raw);
			}
			if (raw.length !== expectedBytes) {
				throw new Error(`expected ${expectedBytes} bytes after decompression, got ${raw.length}`);
			}

			const data = unpack(raw, voxelCount, bitDepth, valueRange);
			self.postMessage({ type: 'decoded', index, data }, [data.buffer]);
		} catch (err) {
			self.postMessage({ type: 'error', index: msg.index, message: String(err?.message || err) });
		}
	}
};
