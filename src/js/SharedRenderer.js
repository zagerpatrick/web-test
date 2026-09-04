import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * SharedRenderer - Singleton managing WebGLRenderer and scissor-based multi-scene render loop
 *
 * Uses the scissor pattern from Three.js manual to:
 * 1. Avoid WebGL context limit (~8 contexts per browser)
 * 2. Share resources (textures, shaders) efficiently across views
 */
class SharedRenderer {
	constructor() {
		if (SharedRenderer.instance) {
			return SharedRenderer.instance;
		}
		SharedRenderer.instance = this;

		this.views = [];
		this.canvas = null;
		this.renderer = null;
		this.loader = null;
		this.isRunning = false;

		// Bind methods for event handlers
		this.render = this.render.bind(this);
		this._updateCanvasTransform = this._updateCanvasTransform.bind(this);
	}

	/**
	 * Initialize the shared renderer with a canvas
	 * @param {HTMLCanvasElement} canvas - The full-page canvas element
	 */
	init(canvas) {
		if (this.renderer) {
			console.warn('SharedRenderer already initialized');
			return this;
		}

		this.canvas = canvas;

		// Create WebGL renderer
		this.renderer = new THREE.WebGLRenderer({
			antialias: true,
			canvas,
			alpha: true  // Allow transparent background
		});
		// No tone mapping: the surface shader writes display values directly (as vispy
		// does) and the remaining basic materials are marked toneMapped: false
		this.renderer.toneMapping = THREE.NoToneMapping;
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;

		// Create shared GLTFLoader
		this.loader = new GLTFLoader();
		this.loader.setMeshoptDecoder(MeshoptDecoder);

		// Setup scroll handler for absolute positioning
		// Canvas uses transform to stay aligned with viewport while scrolling
		window.addEventListener('scroll', this._updateCanvasTransform, { passive: true });
		window.addEventListener('resize', this._updateCanvasTransform);

		return this;
	}

	/**
	 * Update canvas transform to match scroll position
	 * This keeps the absolutely-positioned canvas aligned with the viewport
	 * @private
	 */
	_updateCanvasTransform() {
		if (!this.canvas) return;
		this.canvas.style.transform = `translate(${window.scrollX}px, ${window.scrollY}px)`;
	}

	/**
	 * Get the shared GLTFLoader instance
	 * @returns {GLTFLoader}
	 */
	getLoader() {
		return this.loader;
	}

	/**
	 * Register a view to be rendered
	 * @param {MeshTimeseriesView} view - View instance to register
	 */
	addView(view) {
		if (!this.views.includes(view)) {
			this.views.push(view);
		}
	}

	/**
	 * Unregister a view from rendering
	 * @param {MeshTimeseriesView} view - View instance to remove
	 */
	removeView(view) {
		const index = this.views.indexOf(view);
		if (index !== -1) {
			this.views.splice(index, 1);
		}
	}

	/**
	 * Start the render loop
	 */
	start() {
		if (this.isRunning) return;
		this.isRunning = true;
		// Initial transform update
		this._updateCanvasTransform();
		requestAnimationFrame(this.render);
	}

	/**
	 * Stop the render loop
	 */
	stop() {
		this.isRunning = false;
	}

	/**
	 * Main render loop using scissor-based rendering
	 * Based on Three.js manual: https://threejs.org/manual/#en/multiple-scenes
	 */
	render() {
		if (!this.isRunning) return;

		const renderer = this.renderer;
		const canvas = this.canvas;

		// Resize canvas to match display size
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		const needResize = canvas.width !== width || canvas.height !== height;
		if (needResize) {
			renderer.setSize(width, height, false);
		}

		// Clear the entire canvas first
		renderer.setScissorTest(false);
		renderer.setClearColor(0x000000, 0); // Transparent clear
		renderer.clear();
		renderer.setScissorTest(true);

		// Render each view using scissor
		for (const view of this.views) {
			const elem = view.elem;
			const rect = elem.getBoundingClientRect();

			// Skip views that are completely offscreen
			if (rect.bottom < 0 || rect.top > window.innerHeight ||
				rect.right < 0 || rect.left > window.innerWidth) {
				continue;
			}

			// Calculate scissor/viewport in canvas coordinates
			// With absolute positioning + transform, canvas is aligned to viewport
			// Canvas origin is bottom-left, DOM origin is top-left
			const left = rect.left;
			const bottom = height - rect.bottom;
			const viewWidth = rect.width;
			const viewHeight = rect.height;

			// Update camera aspect ratio if needed
			const aspect = viewWidth / viewHeight;
			if (view.camera.aspect !== aspect) {
				view.camera.aspect = aspect;
				view.camera.updateProjectionMatrix();
			}

			// Update controls
			if (view.controls) {
				view.controls.update();
			}

			// Set scissor and viewport, then render
			renderer.setScissor(left, bottom, viewWidth, viewHeight);
			renderer.setViewport(left, bottom, viewWidth, viewHeight);
			renderer.render(view.scene, view.camera);

			// Render orientation marker in bottom-left corner
			if (view.orientationMarker && view.orientationMarker.isVisible()) {
				const marker = view.orientationMarker;
				const markerSize = marker.getSize();
				const padding = 10;

				// Position in bottom-left corner of this view's region
				const markerX = left + padding;
				const markerY = bottom + padding;

				// Sync marker orientation with the view's camera
				marker.syncWithCamera(view.camera);

				// Set viewport and scissor for marker region
				renderer.setViewport(markerX, markerY, markerSize, markerSize);
				renderer.setScissor(markerX, markerY, markerSize, markerSize);

				// Clear only depth so marker renders on top of existing scene
				// Disable autoClear to preserve the main scene's background
				renderer.autoClear = false;
				renderer.clearDepth();

				// Render marker
				renderer.render(marker.scene, marker.camera);

				// Restore autoClear
				renderer.autoClear = true;
			}
		}

		requestAnimationFrame(this.render);
	}

	/**
	 * Dispose of the shared renderer
	 */
	dispose() {
		this.stop();

		// Remove event listeners
		window.removeEventListener('scroll', this._updateCanvasTransform);
		window.removeEventListener('resize', this._updateCanvasTransform);

		if (this.renderer) {
			this.renderer.dispose();
			this.renderer = null;
		}
		this.views = [];
		this.canvas = null;
		SharedRenderer.instance = null;
	}
}

// Export singleton instance
const sharedRenderer = new SharedRenderer();
export default sharedRenderer;
