import * as THREE from 'three';
import pako from 'pako';

// Lazy-load brotli-wasm only when needed
let brotliModule = null;
async function getBrotli() {
	if (!brotliModule) {
		// Dynamically load brotli-wasm using URL to bypass Vite's import analysis
		const baseUrl = import.meta.env.BASE_URL || '/';
		const jsUrl = new URL(`${baseUrl}brotli_wasm.js`, window.location.origin).href;
		const brotliJs = await import(/* @vite-ignore */ jsUrl);
		// Initialize with explicit path to WASM file
		const wasmUrl = new URL(`${baseUrl}brotli_wasm_bg.wasm`, window.location.origin);
		await brotliJs.default(wasmUrl);
		brotliModule = brotliJs;
	}
	return brotliModule;
}

/**
 * VolumeLoader - Loads gzipped binary volume data and creates Data3DTextures
 *
 * Supports:
 * - Gzipped raw binary files (.bin.gz)
 * - 16-bit unsigned integer data (normalized to 0-1)
 * - Concurrent loading with configurable parallelism
 * - Ring buffer memory management for timeseries
 */
export default class VolumeLoader {
	/**
	 * Create a new VolumeLoader
	 * @param {Object} options - Loader configuration
	 * @param {number} options.concurrency - Max parallel loads (default: 4)
	 * @param {number} options.maxLoadedVolumes - Max volumes in memory (default: 20)
	 */
	constructor(options = {}) {
		this.concurrency = options.concurrency || 4;
		this.maxLoadedVolumes = options.maxLoadedVolumes || 20;

		// Volume cache with LRU tracking
		this.cache = new Map(); // url -> { texture, lastAccess }
		this.accessOrder = []; // LRU tracking

		// Loading state
		this.activeLoads = 0;
		this.loadQueue = [];
		this.loading = new Map(); // url -> Promise
	}

	/**
	 * Load volume metadata from JSON file
	 * @param {string} metadataUrl - URL to metadata.json
	 * @returns {Promise<Object>} Volume metadata
	 */
	async loadMetadata(metadataUrl) {
		const response = await fetch(metadataUrl);
		if (!response.ok) {
			throw new Error(`Failed to load metadata: ${response.statusText}`);
		}
		return response.json();
	}

	/**
	 * Load a single volume and create a Data3DTexture
	 * @param {string} url - URL to the .bin.gz file
	 * @param {Object} metadata - Volume metadata
	 * @param {number[]} metadata.dimensions - [width, height, depth]
	 * @param {string} metadata.dataType - Data type (e.g., 'uint16')
	 * @param {number[]} metadata.valueRange - [min, max] for normalization
	 * @returns {Promise<THREE.Data3DTexture>}
	 */
	async loadVolume(url, metadata) {
		// Check cache first
		if (this.cache.has(url)) {
			const cached = this.cache.get(url);
			cached.lastAccess = Date.now();
			this._updateAccessOrder(url);
			return cached.texture;
		}

		// Check if already loading
		if (this.loading.has(url)) {
			return this.loading.get(url);
		}

		// Create load promise
		const loadPromise = this._doLoad(url, metadata);
		this.loading.set(url, loadPromise);

		try {
			const texture = await loadPromise;
			return texture;
		} finally {
			this.loading.delete(url);
		}
	}

	/**
	 * Internal load implementation
	 * @private
	 */
	async _doLoad(url, metadata) {
		// Fetch compressed data
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to load volume: ${response.statusText}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		let rawData = new Uint8Array(arrayBuffer);

		console.log('VolumeLoader: Fetched', url, 'size:', rawData.length, 'bytes');

		// Calculate expected decompressed size to detect if browser already decompressed
		const [width, height, depth] = metadata.dimensions;
		const expectedVoxels = width * height * depth;
		const bitDepth = metadata.bitDepth || 8;
		const expectedDecompressedSize = bitDepth === 4
			? Math.ceil(expectedVoxels / 2)
			: expectedVoxels * (metadata.dataType === 'uint16' ? 2 : 1);

		// Determine compression type from URL or metadata
		const isBrotli = url.endsWith('.br') || metadata.compression === 'brotli';

		// Check if data needs decompression
		if (rawData.length >= 2 && rawData[0] === 0x1f && rawData[1] === 0x8b) {
			// Data is gzip compressed (magic bytes 0x1f 0x8b)
			console.log('VolumeLoader: Decompressing with pako...');
			rawData = pako.inflate(rawData);
			console.log('VolumeLoader: Decompressed size:', rawData.length, 'bytes');
		} else if (isBrotli && rawData.length !== expectedDecompressedSize) {
			// Brotli decompression needed
			console.log('VolumeLoader: Decompressing with Brotli...');
			try {
				const brotliWasm = await getBrotli();
				rawData = brotliWasm.decompress(rawData);
				console.log('VolumeLoader: Decompressed size:', rawData.length, 'bytes');
			} catch (e) {
				console.error('VolumeLoader: Brotli decompression failed:', e);
				throw e;
			}
		} else if (rawData.length === expectedDecompressedSize) {
			console.log('VolumeLoader: Data already at expected size (decompressed by browser or uncompressed)');
		} else {
			console.warn('VolumeLoader: Unexpected data size!', {
				received: rawData.length,
				expected: expectedDecompressedSize
			});
		}

		// Create texture from raw data
		const texture = this._createTexture(rawData, metadata);

		// Cache with LRU management
		this._addToCache(url, texture);

		return texture;
	}

	/**
	 * Create Data3DTexture from raw volume data
	 * @private
	 */
	_createTexture(rawData, metadata) {
		const [width, height, depth] = metadata.dimensions;
		const expectedSize = width * height * depth;

		console.log('VolumeLoader: Creating texture', {
			dimensions: [width, height, depth],
			dataType: metadata.dataType,
			expectedVoxels: expectedSize,
			actualBytes: rawData.length
		});

		// Validate data size based on data type
		const bitDepth = metadata.bitDepth || (metadata.dataType === 'uint16' ? 16 : 8);
		let actualExpectedBytes;
		if (bitDepth === 4) {
			actualExpectedBytes = Math.ceil(expectedSize / 2); // 2 voxels per byte
		} else if (bitDepth === 8 || metadata.dataType === 'uint8') {
			actualExpectedBytes = expectedSize;
		} else {
			actualExpectedBytes = expectedSize * 2; // uint16
		}

		if (rawData.length !== actualExpectedBytes) {
			console.error('VolumeLoader: Data size mismatch!', {
				dataType: metadata.dataType,
				bitDepth,
				expected: actualExpectedBytes,
				actual: rawData.length
			});
		}

		// Handle different data types
		let normalizedData;

		if (metadata.dataType === 'uint16') {
			// Convert Uint8Array to Uint16Array
			// Create a copy to ensure proper alignment
			const alignedBuffer = new ArrayBuffer(rawData.length);
			new Uint8Array(alignedBuffer).set(rawData);
			const uint16Data = new Uint16Array(alignedBuffer);

			// Normalize to 0-1 range and store as float
			const [minVal, maxVal] = metadata.valueRange || [0, 65535];
			const range = maxVal - minVal || 1;

			console.log('VolumeLoader: Normalizing uint16 data', { minVal, maxVal, range });

			// Use Float32Array for better precision
			normalizedData = new Float32Array(expectedSize);
			for (let i = 0; i < expectedSize; i++) {
				normalizedData[i] = (uint16Data[i] - minVal) / range;
			}
		} else if (metadata.dataType === 'uint4' || bitDepth === 4) {
			// 4-bit packed data - unpack and normalize
			// Each byte contains 2 voxels: high nibble (bits 4-7) and low nibble (bits 0-3)
			const [minVal, maxVal] = metadata.valueRange || [0, 15];
			const range = maxVal - minVal || 1;

			console.log('VolumeLoader: Unpacking 4-bit data', { minVal, maxVal, range, packedBytes: rawData.length });

			normalizedData = new Float32Array(expectedSize);
			for (let i = 0; i < expectedSize; i++) {
				const byteIndex = Math.floor(i / 2);
				const isHighNibble = (i % 2) === 0;
				const value = isHighNibble
					? (rawData[byteIndex] >> 4) & 0x0F
					: rawData[byteIndex] & 0x0F;
				normalizedData[i] = (value - minVal) / range;
			}
		} else if (metadata.dataType === 'uint8') {
			// 8-bit data - normalize directly
			const [minVal, maxVal] = metadata.valueRange || [0, 255];
			const range = maxVal - minVal || 1;

			normalizedData = new Float32Array(expectedSize);
			for (let i = 0; i < expectedSize; i++) {
				normalizedData[i] = (rawData[i] - minVal) / range;
			}
		} else {
			throw new Error(`Unsupported data type: ${metadata.dataType}`);
		}

		// Create 3D texture
		const texture = new THREE.Data3DTexture(normalizedData, width, height, depth);
		texture.format = THREE.RedFormat;
		texture.type = THREE.FloatType;
		texture.internalFormat = 'R32F';
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;
		texture.wrapS = THREE.ClampToEdgeWrapping;
		texture.wrapT = THREE.ClampToEdgeWrapping;
		texture.wrapR = THREE.ClampToEdgeWrapping;
		texture.unpackAlignment = 1;
		texture.needsUpdate = true;

		return texture;
	}

	/**
	 * Add texture to cache with LRU management
	 * @private
	 */
	_addToCache(url, texture) {
		// Evict if at capacity
		while (this.cache.size >= this.maxLoadedVolumes) {
			this._evictLRU();
		}

		this.cache.set(url, {
			texture,
			lastAccess: Date.now()
		});
		this.accessOrder.push(url);
	}

	/**
	 * Update LRU access order
	 * @private
	 */
	_updateAccessOrder(url) {
		const idx = this.accessOrder.indexOf(url);
		if (idx !== -1) {
			this.accessOrder.splice(idx, 1);
		}
		this.accessOrder.push(url);
	}

	/**
	 * Evict least recently used texture
	 * @private
	 */
	_evictLRU() {
		if (this.accessOrder.length === 0) return;

		const urlToEvict = this.accessOrder.shift();
		const cached = this.cache.get(urlToEvict);

		if (cached) {
			cached.texture.dispose();
			this.cache.delete(urlToEvict);
		}
	}

	/**
	 * Load multiple volumes with concurrency control
	 * @param {string[]} urls - URLs to load
	 * @param {Object} metadata - Volume metadata
	 * @param {Function} onProgress - Progress callback (loaded, total)
	 * @returns {Promise<THREE.Data3DTexture[]>}
	 */
	async loadMany(urls, metadata, onProgress) {
		const results = new Array(urls.length);
		let loaded = 0;

		const loadOne = async (index) => {
			const url = urls[index];
			results[index] = await this.loadVolume(url, metadata);
			loaded++;
			if (onProgress) {
				onProgress(loaded, urls.length);
			}
		};

		// Process with concurrency limit
		const queue = urls.map((_, i) => i);
		const workers = [];

		for (let i = 0; i < Math.min(this.concurrency, queue.length); i++) {
			workers.push(this._worker(queue, loadOne));
		}

		await Promise.all(workers);
		return results;
	}

	/**
	 * Worker function for concurrent loading
	 * @private
	 */
	async _worker(queue, loadFn) {
		while (queue.length > 0) {
			const index = queue.shift();
			if (index !== undefined) {
				await loadFn(index);
			}
		}
	}

	/**
	 * Prefetch volumes for smooth playback
	 * @param {string[]} urls - URLs to prefetch
	 * @param {Object} metadata - Volume metadata
	 * @param {number} currentIndex - Current playback position
	 * @param {number} prefetchCount - Number of frames to prefetch ahead (default: 5)
	 */
	prefetch(urls, metadata, currentIndex, prefetchCount = 5) {
		const endIndex = Math.min(currentIndex + prefetchCount, urls.length);

		for (let i = currentIndex; i < endIndex; i++) {
			const url = urls[i];
			// Start loading if not cached and not already loading
			if (!this.cache.has(url) && !this.loading.has(url)) {
				this.loadVolume(url, metadata).catch(() => {
					// Silently ignore prefetch errors
				});
			}
		}
	}

	/**
	 * Check if a volume is cached
	 * @param {string} url - Volume URL
	 * @returns {boolean}
	 */
	isCached(url) {
		return this.cache.has(url);
	}

	/**
	 * Get cached texture without loading
	 * @param {string} url - Volume URL
	 * @returns {THREE.Data3DTexture|null}
	 */
	getCached(url) {
		const cached = this.cache.get(url);
		if (cached) {
			cached.lastAccess = Date.now();
			this._updateAccessOrder(url);
			return cached.texture;
		}
		return null;
	}

	/**
	 * Clear all cached volumes
	 */
	clearCache() {
		for (const { texture } of this.cache.values()) {
			texture.dispose();
		}
		this.cache.clear();
		this.accessOrder = [];
	}

	/**
	 * Get cache statistics
	 * @returns {Object}
	 */
	getCacheStats() {
		return {
			cached: this.cache.size,
			maxSize: this.maxLoadedVolumes,
			loading: this.loading.size
		};
	}

	/**
	 * Dispose of the loader and all cached textures
	 */
	dispose() {
		this.clearCache();
		this.loading.clear();
	}
}
