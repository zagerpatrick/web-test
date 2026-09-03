import sharedRenderer from './js/SharedRenderer.js';
import MeshTimeseriesView from './js/MeshTimeseriesView.js';
import VolumeTimeseriesView from './js/VolumeTimeseriesView.js';

/**
 * Main orchestration layer
 * Initializes the shared renderer and auto-wires views from data attributes
 */

// Store references to all views
const meshViews = [];
const volumeViews = [];
let focusedView = null;

/**
 * Initialize the application
 */
function init() {
	// Initialize shared renderer with the full-page canvas
	const canvas = document.querySelector('#c');
	sharedRenderer.init(canvas);

	// Auto-create mesh views from HTML data attributes
	initMeshViews();

	// Auto-create volume views from HTML data attributes
	initVolumeViews();

	// Setup keyboard controls for focused view
	setupKeyboardControls();

	// Start the render loop
	sharedRenderer.start();
}

/**
 * Initialize mesh timeseries views
 */
function initMeshViews() {
	document.querySelectorAll('.mesh-view').forEach((elem) => {
		const wrapper = elem.closest('.mesh-view-wrapper');

		// Get configuration from data attributes.
		// data-meshcount and data-startindex are optional overrides; when omitted the
		// view discovers the numbering origin and the file count from the server.
		const basePath = elem.dataset.basepath || 'data/meshes/mesh';
		const meshCount = elem.dataset.meshcount ? parseInt(elem.dataset.meshcount, 10) : undefined;
		const startIndex = elem.dataset.startindex ? parseInt(elem.dataset.startindex, 10) : undefined;
		const useVertexColors = elem.dataset.vertexcolors === 'true';

		// Get control elements
		const playBtn = wrapper.querySelector('.view-play');
		const timeline = wrapper.querySelector('.view-timeline');
		const frameSpan = wrapper.querySelector('.view-frame');
		const speedSlider = wrapper.querySelector('.view-speed');
		const speedValue = wrapper.querySelector('.view-speed-value');
		const progressBar = wrapper.querySelector('.progress-bar');
		const progressText = wrapper.querySelector('.progress-text');
		const progressContainer = wrapper.querySelector('.view-progress');

		// Create the view
		const view = new MeshTimeseriesView({
			elem,
			basePath,
			meshCount,
			startIndex,
			enableControls: true,
			useVertexColors,
			onCountResolved: (count) => {
				// Timeline range and progress total follow the resolved count
				if (timeline) timeline.max = Math.max(count - 1, 0);
				if (progressText) progressText.textContent = `0/${count}`;
			},
			onLoadProgress: (loaded, total) => {
				const percent = Math.round((loaded / total) * 100);
				if (progressBar) progressBar.style.width = `${percent}%`;
				if (progressText) progressText.textContent = `${loaded}/${total}`;
			},
			onLoadComplete: () => {
				// Fade out progress bar when done
				if (progressContainer) {
					progressContainer.classList.add('hidden');
				}
			},
			onFrameChange: (frameIndex, isLoaded) => {
				if (timeline) timeline.value = frameIndex;
				if (frameSpan) {
					frameSpan.textContent = String(frameIndex).padStart(3, '0') +
						(isLoaded ? '' : '...');
				}
			}
		});

		// Wire up play button
		if (playBtn) {
			playBtn.addEventListener('click', () => {
				const isPlaying = view.togglePlay();
				playBtn.textContent = isPlaying ? 'Pause' : 'Play';
			});
		}

		// Wire up timeline slider
		if (timeline) {
			timeline.addEventListener('input', () => {
				view.pause();
				view.setFrame(parseInt(timeline.value));
				if (playBtn) playBtn.textContent = 'Play';
			});
		}

		// Wire up speed slider
		if (speedSlider) {
			speedSlider.addEventListener('input', () => {
				const speed = parseInt(speedSlider.value);
				view.setPlaySpeed(speed);
				if (speedValue) speedValue.textContent = `${speed}ms`;
			});
		}

		// Wire up view preset buttons
		wrapper.querySelectorAll('.view-btn').forEach(btn => {
			btn.addEventListener('click', () => {
				view.setView(btn.dataset.view);
			});
		});

		// Track focus for keyboard controls
		elem.addEventListener('mouseenter', () => {
			focusedView = { view, playBtn };
		});

		elem.addEventListener('mouseleave', () => {
			if (focusedView?.view === view) {
				focusedView = null;
			}
		});

		// Store view reference
		meshViews.push({ view, playBtn, timeline, frameSpan });
	});
}

/**
 * Initialize volume timeseries views
 */
function initVolumeViews() {
	document.querySelectorAll('.volume-view').forEach((elem) => {
		const wrapper = elem.closest('.volume-view-wrapper');

		// Get configuration from data attributes
		const basePath = elem.dataset.basepath || 'data/volumes/';

		// Get control elements
		const playBtn = wrapper.querySelector('.view-play');
		const timeline = wrapper.querySelector('.view-timeline');
		const frameSpan = wrapper.querySelector('.view-frame');
		const speedSlider = wrapper.querySelector('.view-speed');
		const speedValue = wrapper.querySelector('.view-speed-value');
		const progressBar = wrapper.querySelector('.progress-bar');
		const progressText = wrapper.querySelector('.progress-text');
		const progressContainer = wrapper.querySelector('.view-progress');

		// Volume-specific controls
		const renderModeSelect = wrapper.querySelector('.volume-render-mode');
		const colormapSelect = wrapper.querySelector('.volume-colormap');
		const contrastSlider = wrapper.querySelector('.volume-contrast');
		const contrastMinSlider = wrapper.querySelector('.volume-contrast-min');
		const contrastMaxSlider = wrapper.querySelector('.volume-contrast-max');
		const contrastFill = wrapper.querySelector('.range-slider-fill');
		const contrastValue = wrapper.querySelector('.volume-contrast-value');
		const opacitySlider = wrapper.querySelector('.volume-opacity');
		const opacityValue = wrapper.querySelector('.volume-opacity-value');
		const qualitySlider = wrapper.querySelector('.volume-quality');
		const qualityValue = wrapper.querySelector('.volume-quality-value');

		// Create the volume view
		const view = new VolumeTimeseriesView({
			elem,
			basePath,
			enableControls: true,
			colormap: 'grayscale',
			renderMode: 'mip',
			contrastMin: 0.1,
			contrastMax: 1.0,
			opacity: 1.0,
			stepCount: 256,
			onMetadataLoaded: (metadata) => {
				// Update timeline max based on frame count
				if (timeline) {
					timeline.max = metadata.frameCount - 1;
				}
				if (progressText) {
					progressText.textContent = `0/${metadata.frameCount}`;
				}
			},
			onLoadProgress: (loaded, total) => {
				const percent = Math.round((loaded / total) * 100);
				if (progressBar) progressBar.style.width = `${percent}%`;
				if (progressText) progressText.textContent = `${loaded}/${total}`;
			},
			onLoadComplete: () => {
				// Fade out progress bar when done
				if (progressContainer) {
					progressContainer.classList.add('hidden');
				}
			},
			onFrameChange: (frameIndex, isLoaded) => {
				if (timeline) timeline.value = frameIndex;
				if (frameSpan) {
					frameSpan.textContent = String(frameIndex).padStart(3, '0') +
						(isLoaded ? '' : '...');
				}
			}
		});

		// Wire up play button
		if (playBtn) {
			playBtn.addEventListener('click', () => {
				const isPlaying = view.togglePlay();
				playBtn.textContent = isPlaying ? 'Pause' : 'Play';
			});
		}

		// Wire up timeline slider
		if (timeline) {
			timeline.addEventListener('input', () => {
				view.pause();
				view.setFrame(parseInt(timeline.value));
				if (playBtn) playBtn.textContent = 'Play';
			});
		}

		// Wire up speed slider
		if (speedSlider) {
			speedSlider.addEventListener('input', () => {
				const speed = parseInt(speedSlider.value);
				view.setPlaySpeed(speed);
				if (speedValue) speedValue.textContent = `${speed}ms`;
			});
		}

		// Wire up render mode selector
		if (renderModeSelect) {
			renderModeSelect.addEventListener('change', () => {
				view.setRenderMode(renderModeSelect.value);
			});
		}

		// Wire up colormap selector
		if (colormapSelect) {
			colormapSelect.addEventListener('change', () => {
				view.setColormap(colormapSelect.value);
			});
		}

		// Wire up contrast limits (dual-handle slider, ImageJ / napari style)
		if (contrastMinSlider && contrastMaxSlider) {
			const applyContrast = (activeHandle) => {
				let min = parseInt(contrastMinSlider.value);
				let max = parseInt(contrastMaxSlider.value);
				// Keep the handles from crossing: the dragged handle pushes the other
				if (min > max) {
					if (activeHandle === contrastMinSlider) {
						max = min;
						contrastMaxSlider.value = max;
					} else {
						min = max;
						contrastMinSlider.value = min;
					}
				}
				view.setContrastLimits(min / 100, max / 100);
				if (contrastFill) {
					contrastFill.style.left = `${min}%`;
					contrastFill.style.width = `${max - min}%`;
				}
				if (contrastValue) contrastValue.textContent = `${min}–${max}%`;
				// Raise the handle being dragged so it stays grabbable at the extremes
				if (contrastSlider) {
					contrastSlider.classList.toggle('max-active', activeHandle === contrastMaxSlider);
				}
			};
			contrastMinSlider.addEventListener('input', () => applyContrast(contrastMinSlider));
			contrastMaxSlider.addEventListener('input', () => applyContrast(contrastMaxSlider));
			applyContrast(contrastMaxSlider);
		}

		// Wire up opacity slider
		if (opacitySlider) {
			opacitySlider.addEventListener('input', () => {
				const value = parseInt(opacitySlider.value);
				view.setOpacity(value / 100);
				if (opacityValue) opacityValue.textContent = `${value}%`;
			});
		}

		// Wire up quality slider
		if (qualitySlider) {
			qualitySlider.addEventListener('input', () => {
				const value = parseInt(qualitySlider.value);
				view.setStepCount(value);
				if (qualityValue) qualityValue.textContent = String(value);
			});
		}

		// Wire up view preset buttons
		wrapper.querySelectorAll('.view-btn').forEach(btn => {
			btn.addEventListener('click', () => {
				view.setView(btn.dataset.view);
			});
		});

		// Track focus for keyboard controls
		elem.addEventListener('mouseenter', () => {
			focusedView = { view, playBtn };
		});

		elem.addEventListener('mouseleave', () => {
			if (focusedView?.view === view) {
				focusedView = null;
			}
		});

		// Store view reference
		volumeViews.push({ view, playBtn, timeline, frameSpan });
	});
}

/**
 * Setup keyboard controls that work on the focused view
 */
function setupKeyboardControls() {
	document.addEventListener('keydown', (e) => {
		// Only handle if a view is focused
		if (!focusedView) return;

		const { view, playBtn } = focusedView;

		if (e.code === 'Space') {
			e.preventDefault();
			const isPlaying = view.togglePlay();
			if (playBtn) {
				playBtn.textContent = isPlaying ? 'Pause' : 'Play';
			}
		} else if (e.code === 'ArrowRight') {
			e.preventDefault();
			view.stepForward();
			if (playBtn) {
				playBtn.textContent = 'Play';
			}
		} else if (e.code === 'ArrowLeft') {
			e.preventDefault();
			view.stepBackward();
			if (playBtn) {
				playBtn.textContent = 'Play';
			}
		}
	});
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
