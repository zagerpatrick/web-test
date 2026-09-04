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
 * Read the list of datasets a viewer can flip between.
 *
 * The wrapper's `data-datasets` attribute holds a JSON array of
 * `{ basePath, label, caption, ... }` objects. Without it the viewer has a single
 * dataset taken from the view element's own attributes (`data-basepath`, ...).
 * Every dataset inherits `defaults`, so per-dataset entries only need to list
 * what differs. `label` is optional: when omitted it is derived from the data
 * folder name (see labelFromBasePath).
 * @param {HTMLElement} wrapper
 * @param {Object} defaults - Values derived from the view element's data attributes
 * @returns {Object[]} At least one dataset
 */
function readDatasets(wrapper, defaults) {
	const raw = wrapper?.dataset.datasets;
	if (raw) {
		try {
			const list = JSON.parse(raw);
			if (Array.isArray(list) && list.length > 0) {
				return list.map((ds) => ({ ...defaults, ...ds }));
			}
			console.warn('data-datasets must be a non-empty JSON array; using the view element attributes instead');
		} catch (error) {
			console.error('Invalid JSON in data-datasets:', error);
		}
	}
	return [{ ...defaults }];
}

/**
 * Derive a display label from a dataset's data folder.
 *
 * Folders follow `<kind>_<cell>_<YYYYMMDD>`, e.g. `data/volumes_21_20260731/` or
 * `data/meshes_21_20260731/mesh` -> "20260731 Cell 21". Any other folder name is
 * shown as-is; an empty path gives null so the caller can fall back.
 * @param {string} basePath - Directory (volumes) or file prefix (meshes)
 * @returns {string|null}
 */
function labelFromBasePath(basePath) {
	if (!basePath) return null;
	const match = /(?:^|\/)(?:[^/]+_)?(\d+)_(\d{8})\/?(?:[^/]*)$/.exec(basePath);
	if (match) return `${match[2]} Cell ${match[1]}`;
	const segments = basePath.split('/').filter(Boolean);
	// A mesh basePath ends in a file prefix; a volume basePath ends in the folder
	const folder = basePath.endsWith('/') ? segments[segments.length - 1] : segments[segments.length - 2];
	return folder || null;
}

/**
 * Wire the prev/next dataset arrows and label in the header bar of one viewer
 * (eLife figure-supplement style). The arrows disable at either end rather than
 * wrapping. Hidden when there is only one dataset.
 * @param {HTMLElement} wrapper
 * @param {Object[]} datasets
 * @param {Function} onChange - (dataset, index) called after the arrows move
 */
function wireDatasetNav(wrapper, datasets, onChange) {
	const nav = wrapper.querySelector('.dataset-nav');
	const prevBtn = wrapper.querySelector('.dataset-prev');
	const nextBtn = wrapper.querySelector('.dataset-next');
	const label = wrapper.querySelector('.dataset-label');

	let index = 0;

	const render = () => {
		const ds = datasets[index];
		if (label) label.textContent = ds.label || labelFromBasePath(ds.basePath) || `Dataset ${index + 1}`;
		if (prevBtn) prevBtn.disabled = index === 0;
		if (nextBtn) nextBtn.disabled = index === datasets.length - 1;
	};

	if (datasets.length < 2) {
		if (nav) nav.hidden = true;
		render();
		return;
	}

	const go = (delta) => {
		const next = index + delta;
		if (next < 0 || next >= datasets.length) return;
		index = next;
		render();
		onChange(datasets[index], index);
	};

	if (prevBtn) prevBtn.addEventListener('click', () => go(-1));
	if (nextBtn) nextBtn.addEventListener('click', () => go(1));
	render();
}

/**
 * Camera presets offered by the view buttons above every viewer, in display
 * order. `id` is passed to `view.setView()` and names the icon in `icons/`.
 */
const VIEW_PRESETS = [
	{ id: 'iso', label: 'Isometric' },
	{ id: 'top', label: 'Top' },
	{ id: 'bottom', label: 'Bottom' },
	{ id: 'front', label: 'Front' },
	{ id: 'back', label: 'Back' },
	{ id: 'left', label: 'Left' },
	{ id: 'right', label: 'Right' }
];

/**
 * Fill the `.view-buttons` bar of one viewer with a button per camera preset
 * and wire each to `view.setView()`. Any buttons already present in the markup
 * are kept and wired instead of being rebuilt.
 * @param {HTMLElement} wrapper
 * @param {{setView: Function}} view
 */
function wireViewButtons(wrapper, view) {
	const container = wrapper.querySelector('.view-buttons');
	if (!container) return;

	if (!container.querySelector('.view-btn')) {
		for (const { id, label } of VIEW_PRESETS) {
			const btn = document.createElement('button');
			btn.className = 'view-btn';
			btn.dataset.view = id;
			btn.title = label;

			const icon = document.createElement('img');
			icon.src = `icons/${id}.svg`;
			icon.width = 30;
			icon.height = 30;
			icon.alt = `${label} view`;

			btn.appendChild(icon);
			container.appendChild(btn);
		}
	}

	container.querySelectorAll('.view-btn').forEach((btn) => {
		btn.addEventListener('click', () => view.setView(btn.dataset.view));
	});
}

/**
 * Show the play triangle or the pause bars on a play button
 * @param {HTMLButtonElement|null} playBtn
 * @param {boolean} isPlaying
 */
function setPlayButton(playBtn, isPlaying) {
	if (!playBtn) return;
	playBtn.classList.toggle('playing', isPlaying);
	const label = isPlaying ? 'Pause' : 'Play';
	playBtn.setAttribute('aria-label', label);
	playBtn.title = label;
}

/**
 * Put the playback and loading controls back to their pre-load state so the
 * progress of a newly selected dataset is shown from zero.
 */
function resetLoadUi({ playBtn, timeline, frameSpan, progressBar, progressText, progressContainer }) {
	setPlayButton(playBtn, false);
	if (timeline) {
		timeline.max = 0;
		timeline.value = 0;
	}
	if (frameSpan) frameSpan.textContent = '000';
	if (progressBar) progressBar.style.width = '0%';
	if (progressText) progressText.textContent = '0/…';
	if (progressContainer) progressContainer.classList.remove('hidden');
}

/**
 * Initialize mesh timeseries views
 */
function initMeshViews() {
	document.querySelectorAll('.mesh-view').forEach((elem) => {
		const wrapper = elem.closest('.mesh-view-wrapper');

		// Defaults come from the view element; the wrapper's data-datasets list
		// (if any) overrides them per dataset. data-meshcount and data-startindex are
		// optional: when omitted the view discovers the numbering origin and the file
		// count from the server. The coverslip attributes (data-coverslip="false",
		// data-coverslip-size, data-coverslip-opacity) apply to the whole view.
		const datasets = readDatasets(wrapper, {
			basePath: elem.dataset.basepath || 'data/meshes/mesh',
			meshCount: elem.dataset.meshcount ? parseInt(elem.dataset.meshcount, 10) : undefined,
			startIndex: elem.dataset.startindex ? parseInt(elem.dataset.startindex, 10) : undefined,
			vertexColors: elem.dataset.vertexcolors === 'true'
		});
		const first = datasets[0];

		// Get control elements
		const playBtn = wrapper.querySelector('.view-play');
		const timeline = wrapper.querySelector('.view-timeline');
		const frameSpan = wrapper.querySelector('.view-frame');
		const fpsInput = wrapper.querySelector('.view-fps');
		const progressBar = wrapper.querySelector('.progress-bar');
		const progressText = wrapper.querySelector('.progress-text');
		const progressContainer = wrapper.querySelector('.view-progress');
		const loadUi = { playBtn, timeline, frameSpan, progressBar, progressText, progressContainer };

		// Create the view
		const view = new MeshTimeseriesView({
			elem,
			basePath: first.basePath,
			meshCount: first.meshCount,
			startIndex: first.startIndex,
			enableControls: true,
			useVertexColors: !!first.vertexColors,
			showCoverslip: elem.dataset.coverslip !== 'false',
			coverslipSize: elem.dataset.coverslipSize ? parseFloat(elem.dataset.coverslipSize) : undefined,
			coverslipOpacity: elem.dataset.coverslipOpacity ? parseFloat(elem.dataset.coverslipOpacity) : undefined,
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

		// Wire up dataset arrows (no-op with a single dataset)
		wireDatasetNav(wrapper, datasets, (ds) => {
			resetLoadUi(loadUi);
			view.setDataset({
				basePath: ds.basePath,
				meshCount: ds.meshCount,
				startIndex: ds.startIndex,
				useVertexColors: !!ds.vertexColors
			});
		});

		// Wire up play button
		if (playBtn) {
			playBtn.addEventListener('click', () => {
				const isPlaying = view.togglePlay();
				setPlayButton(playBtn, isPlaying);
			});
		}

		// Wire up timeline slider
		if (timeline) {
			timeline.addEventListener('input', () => {
				view.pause();
				view.setFrame(parseInt(timeline.value));
				setPlayButton(playBtn, false);
			});
		}

		// Wire up frames-per-second number box
		if (fpsInput) {
			wireFpsInput(fpsInput, view);
		}

		// Wire up view preset buttons
		wireViewButtons(wrapper, view);

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

		// Defaults come from the view element; the wrapper's data-datasets list
		// (if any) overrides them per dataset. A dataset may also carry
		// contrastMin / contrastMax (0-1) and gamma (0.2-2) presets. The coverslip
		// attributes (data-coverslip="false", data-coverslip-opacity) apply to the view.
		const datasets = readDatasets(wrapper, {
			basePath: elem.dataset.basepath || 'data/volumes/'
		});
		const first = datasets[0];

		// Get control elements
		const playBtn = wrapper.querySelector('.view-play');
		const timeline = wrapper.querySelector('.view-timeline');
		const frameSpan = wrapper.querySelector('.view-frame');
		const fpsInput = wrapper.querySelector('.view-fps');
		const progressBar = wrapper.querySelector('.progress-bar');
		const progressText = wrapper.querySelector('.progress-text');
		const progressContainer = wrapper.querySelector('.view-progress');
		const loadUi = { playBtn, timeline, frameSpan, progressBar, progressText, progressContainer };

		// Volume-specific controls
		const contrastSlider = wrapper.querySelector('.volume-contrast');
		const contrastMinSlider = wrapper.querySelector('.volume-contrast-min');
		const contrastMaxSlider = wrapper.querySelector('.volume-contrast-max');
		const contrastFill = wrapper.querySelector('.range-slider-fill');
		const contrastValue = wrapper.querySelector('.volume-contrast-value');
		const gammaSlider = wrapper.querySelector('.volume-gamma');
		const gammaValue = wrapper.querySelector('.volume-gamma-value');

		// A dataset preset moves the sliders before the value is applied
		const applyDatasetPresets = (ds) => {
			if (contrastMinSlider && Number.isFinite(ds.contrastMin)) {
				contrastMinSlider.value = Math.round(ds.contrastMin * 100);
			}
			if (contrastMaxSlider && Number.isFinite(ds.contrastMax)) {
				contrastMaxSlider.value = Math.round(ds.contrastMax * 100);
			}
			if (gammaSlider && Number.isFinite(ds.gamma)) {
				gammaSlider.value = Math.round(ds.gamma * 100);
			}
		};
		applyDatasetPresets(first);

		// Initial display settings come from the controls' starting values in the
		// HTML so the first render matches what the sliders show.
		const initialContrastMin = contrastMinSlider ? parseInt(contrastMinSlider.value) / 100 : 0.1;
		const initialContrastMax = contrastMaxSlider ? parseInt(contrastMaxSlider.value) / 100 : 1.0;
		const initialGamma = gammaSlider ? parseInt(gammaSlider.value) / 100 : 1.0;

		// Create the volume view
		const view = new VolumeTimeseriesView({
			elem,
			basePath: first.basePath,
			enableControls: true,
			contrastMin: initialContrastMin,
			contrastMax: initialContrastMax,
			gamma: initialGamma,
			stepCount: 512,
			showCoverslip: elem.dataset.coverslip !== 'false',
			coverslipOpacity: elem.dataset.coverslipOpacity ? parseFloat(elem.dataset.coverslipOpacity) : undefined,
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
				setPlayButton(playBtn, isPlaying);
			});
		}

		// Wire up timeline slider
		if (timeline) {
			timeline.addEventListener('input', () => {
				view.pause();
				view.setFrame(parseInt(timeline.value));
				setPlayButton(playBtn, false);
			});
		}

		// Wire up frames-per-second number box
		if (fpsInput) {
			wireFpsInput(fpsInput, view);
		}

		// Wire up contrast limits (dual-handle slider, ImageJ / napari style)
		let applyContrast = null;
		if (contrastMinSlider && contrastMaxSlider) {
			applyContrast = (activeHandle) => {
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
		let applyGamma = null;
		if (gammaSlider) {
			applyGamma = () => {
				const gamma = parseInt(gammaSlider.value) / 100;
				view.setGamma(gamma);
				if (gammaValue) gammaValue.textContent = gamma.toFixed(2);
			};
			gammaSlider.addEventListener('input', applyGamma);
			applyGamma();
		}

		// Wire up dataset arrows (no-op with a single dataset)
		wireDatasetNav(wrapper, datasets, (ds) => {
			resetLoadUi(loadUi);
			applyDatasetPresets(ds);
			if (applyContrast) applyContrast(contrastMaxSlider);
			if (applyGamma) applyGamma();
			view.setDataset({ basePath: ds.basePath });
		});

		// Wire up view preset buttons
		wireViewButtons(wrapper, view);

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
			setPlayButton(playBtn, isPlaying);
		} else if (e.code === 'ArrowRight') {
			e.preventDefault();
			view.stepForward();
			setPlayButton(playBtn, false);
		} else if (e.code === 'ArrowLeft') {
			e.preventDefault();
			view.stepBackward();
			setPlayButton(playBtn, false);
		}
	});
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
