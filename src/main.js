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
		const fpsInput = wrapper.querySelector('.view-fps');
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

		// Wire up frames-per-second number box
		if (fpsInput) {
			wireFpsInput(fpsInput, view);
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
		const fpsInput = wrapper.querySelector('.view-fps');
		const progressBar = wrapper.querySelector('.progress-bar');
		const progressText = wrapper.querySelector('.progress-text');
		const progressContainer = wrapper.querySelector('.view-progress');

		// Volume-specific controls
		const contrastSlider = wrapper.querySelector('.volume-contrast');
		const contrastMinSlider = wrapper.querySelector('.volume-contrast-min');
		const contrastMaxSlider = wrapper.querySelector('.volume-contrast-max');
		const contrastFill = wrapper.querySelector('.range-slider-fill');
		const contrastValue = wrapper.querySelector('.volume-contrast-value');
		const gammaSlider = wrapper.querySelector('.volume-gamma');
		const gammaValue = wrapper.querySelector('.volume-gamma-value');

		// Create the volume view
		const view = new VolumeTimeseriesView({
			elem,
			basePath,
			enableControls: true,
			contrastMin: 0.1,
			contrastMax: 1.0,
			gamma: 1.0,
			stepCount: 512,
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

		// Wire up frames-per-second number box
		if (fpsInput) {
			wireFpsInput(fpsInput, view);
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

		// Wire up gamma slider (slider is in hundredths: 20-200 -> 0.20-2.00)
		if (gammaSlider) {
			gammaSlider.addEventListener('input', () => {
				const gamma = parseInt(gammaSlider.value) / 100;
				view.setGamma(gamma);
				if (gammaValue) gammaValue.textContent = gamma.toFixed(2);
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
 * Wire a number input (frames per second) to a view's playback speed.
 * Applies on every keystroke / spinner click, and snaps out-of-range or
 * empty values back into the input's min/max when the box loses focus.
 * @param {HTMLInputElement} input
 * @param {{setFps: Function, getFps: Function}} view
 */
function wireFpsInput(input, view) {
	const min = parseFloat(input.min) || 1;
	const max = parseFloat(input.max) || 60;

	const apply = () => {
		const fps = parseFloat(input.value);
		if (!Number.isFinite(fps) || fps <= 0) return;
		view.setFps(Math.min(max, Math.max(min, fps)));
	};

	input.addEventListener('input', apply);
	input.addEventListener('change', () => {
		apply();
		// Normalise what the user sees to the value actually in use
		input.value = String(view.getFps());
	});

	// Initialise the view from the input's starting value
	apply();
}

/**
 * Setup keyboard controls that work on the focused view
 */
function setupKeyboardControls() {
	document.addEventListener('keydown', (e) => {
		// Only handle if a view is focused
		if (!focusedView) return;

		// Leave keys alone while typing in a form control (e.g. the FPS box)
		const tag = e.target && e.target.tagName;
		if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

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
