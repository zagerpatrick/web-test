import sharedRenderer from './js/SharedRenderer.js';
import MeshTimeseriesView from './js/MeshTimeseriesView.js';
import VolumeTimeseriesView from './js/VolumeTimeseriesView.js';
import { initThemeToggle } from './js/theme.js';

/**
 * Main orchestration layer
 * Initializes the shared renderer and auto-wires views from data attributes
 */

// The view under the pointer, which the keyboard shortcuts act on
let focusedView = null;

/**
 * Initialize the application
 */
function init() {
	// Dark / light theme switch (the theme itself is applied from the <head>)
	initThemeToggle();

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
	const list = readJsonList(wrapper?.dataset.datasets, 'data-datasets', () => true);
	return list ? list.map((ds) => ({ ...defaults, ...ds })) : [{ ...defaults }];
}

/**
 * Parse a data attribute holding a non-empty JSON array whose entries all pass
 * `isValid`; problems are logged and give null so the caller can fall back.
 * @param {string|undefined} raw - Attribute value
 * @param {string} attrName - For the log messages
 * @param {Function} isValid - Predicate applied to each entry
 * @returns {Object[]|null}
 */
function readJsonList(raw, attrName, isValid) {
	if (!raw) return null;
	try {
		const list = JSON.parse(raw);
		if (Array.isArray(list) && list.length > 0 && list.every(isValid)) return list;
		console.warn(`${attrName} must be a non-empty JSON array of valid entries; ignoring it`);
	} catch (error) {
		console.error(`Invalid JSON in ${attrName}:`, error);
	}
	return null;
}

/**
 * A numeric data attribute, or undefined when absent or not a number
 * @param {HTMLElement} elem
 * @param {string} name - camelCase dataset key (data-coverslip-size -> coverslipSize)
 * @returns {number|undefined}
 */
function numberAttr(elem, name) {
	const value = parseFloat(elem.dataset[name]);
	return Number.isFinite(value) ? value : undefined;
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
 * Camera-preset icons, bundled as markup at build time and inlined into the
 * buttons so their cube faces can use the `--icon-face*` theme tokens (the
 * files in `src/icons/` reference the tokens directly and carry icon-specific
 * class names, so several inlined icons coexist on one page).
 */
const ICONS = import.meta.glob('./icons/*.svg', { query: '?raw', import: 'default', eager: true });

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
			btn.setAttribute('aria-label', `${label} view`);
			btn.innerHTML = ICONS[`./icons/${id}.svg`] ?? label[0];
			container.appendChild(btn);
		}
	}

	container.querySelectorAll('.view-btn').forEach((btn) => {
		btn.addEventListener('click', () => view.setView(btn.dataset.view));
	});
}

// How long the controls hint stays up after the pointer enters a view, and
// after the first touch (shorter: it sits over what the finger is dragging)
const VIEW_HINT_DURATION_MS = 8000;
const VIEW_HINT_TOUCH_DURATION_MS = 4000;

/**
 * Fade in a view's `.view-hint` overlay the first time the view is used - when
 * the mouse pointer enters it, or when a finger first touches it - and fade it
 * out a few seconds later. Later hovers and touches show nothing. A touch adds
 * the `touch` class, which swaps the mouse / keyboard lines for the touch
 * gestures (see .hint-mouse / .hint-touch in viewer.css).
 * Does nothing for views without a hint element.
 * @param {HTMLElement} elem - The .mesh-view / .volume-view element
 */
function wireViewHint(elem) {
	const hint = elem.querySelector('.view-hint');
	if (!hint) return;

	let shown = false;
	const show = (isTouch) => {
		if (shown) return;
		shown = true;
		hint.classList.toggle('touch', isTouch);
		hint.classList.add('visible');
		setTimeout(
			() => hint.classList.remove('visible'),
			isTouch ? VIEW_HINT_TOUCH_DURATION_MS : VIEW_HINT_DURATION_MS
		);
	};

	// A tap also fires a synthetic mouseenter afterwards, which `shown` ignores
	elem.addEventListener('pointerdown', (e) => {
		if (e.pointerType === 'touch') show(true);
	});
	elem.addEventListener('mouseenter', () => show(false));
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
 * Text for the frame counter: the zero-padded frame index, or, when the view
 * declares how many seconds one frame spans (`data-frame-interval`), the elapsed
 * time as `MMm SSs` counted from 0 at the first frame.
 * @param {number} frameIndex
 * @param {number|undefined} frameInterval - Seconds per frame, or undefined for a plain index
 * @returns {string}
 */
function formatFrame(frameIndex, frameInterval) {
	if (!(frameInterval > 0)) return String(frameIndex).padStart(3, '0');
	const totalSeconds = Math.round(frameIndex * frameInterval);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Look up the playback and loading controls of one viewer wrapper and build the
 * pieces shared by mesh and volume views: the load / frame callbacks for the
 * view options, a reset for dataset switches, and the control wiring.
 *
 * Attributes read from the view element: `data-frame-interval` (seconds per
 * frame; the counter then shows elapsed time, see formatFrame) and
 * `data-autoplay="true"` (start playback once every file has loaded).
 * @param {HTMLElement} wrapper - The .mesh-view-wrapper / .volume-view-wrapper
 * @param {HTMLElement} elem - The .mesh-view / .volume-view element
 */
function setupPlaybackUi(wrapper, elem) {
	const playBtn = wrapper.querySelector('.view-play');
	const timeline = wrapper.querySelector('.view-timeline');
	const frameSpan = wrapper.querySelector('.view-frame');
	const fpsInput = wrapper.querySelector('.view-fps');
	const progressBar = wrapper.querySelector('.progress-bar');
	const progressText = wrapper.querySelector('.progress-text');
	const progressContainer = wrapper.querySelector('.view-progress');
	const frameInterval = numberAttr(elem, 'frameInterval');
	const autoplay = elem.dataset.autoplay === 'true';
	let view = null;

	const ui = {
		/**
		 * Size the timeline and the progress total once the frame count is known
		 * @param {number} count
		 */
		setFrameCount(count) {
			if (timeline) timeline.max = Math.max(count - 1, 0);
			if (progressText) progressText.textContent = `0/${count}`;
		},

		/**
		 * Put the controls back to their pre-load state so the progress of a
		 * newly selected dataset is shown from zero
		 */
		reset() {
			setPlayButton(playBtn, false);
			if (timeline) {
				timeline.max = 0;
				timeline.value = 0;
			}
			if (frameSpan) frameSpan.textContent = formatFrame(0, frameInterval);
			if (progressBar) progressBar.style.width = '0%';
			if (progressText) progressText.textContent = '0/…';
			if (progressContainer) progressContainer.classList.remove('hidden');
		},

		/** View options: spread into the view constructor */
		callbacks: {
			onLoadProgress: (loaded, total) => {
				const percent = Math.round((loaded / total) * 100);
				if (progressBar) progressBar.style.width = `${percent}%`;
				if (progressText) progressText.textContent = `${loaded}/${total}`;
			},
			onLoadComplete: () => {
				// Fade out progress bar when done
				if (progressContainer) progressContainer.classList.add('hidden');
				// Autoplay once everything is in memory (also after a dataset switch)
				if (autoplay && view) {
					view.play();
					setPlayButton(playBtn, true);
				}
			},
			onFrameChange: (frameIndex, isLoaded) => {
				if (timeline) timeline.value = frameIndex;
				if (frameSpan) {
					frameSpan.textContent = formatFrame(frameIndex, frameInterval) + (isLoaded ? '' : '...');
				}
			}
		},

		/**
		 * Attach the controls to the constructed view
		 * @param {Object} constructedView - A MeshTimeseriesView or VolumeTimeseriesView
		 */
		wire(constructedView) {
			view = constructedView;

			if (playBtn) {
				playBtn.addEventListener('click', () => {
					setPlayButton(playBtn, view.togglePlay());
				});
			}

			if (timeline) {
				timeline.addEventListener('input', () => {
					view.pause();
					view.setFrame(parseInt(timeline.value));
					setPlayButton(playBtn, false);
				});
			}

			if (fpsInput) wireFpsInput(fpsInput, view);

			wireViewButtons(wrapper, view);
			wireViewHint(elem);

			// Track the view under the pointer for the keyboard shortcuts
			elem.addEventListener('mouseenter', () => {
				focusedView = { view, playBtn };
			});
			elem.addEventListener('mouseleave', () => {
				if (focusedView?.view === view) focusedView = null;
			});
		}
	};

	// The markup's initial counter / progress text need not match the attributes
	ui.reset();
	return ui;
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
		// data-coverslip-size, data-coverslip-opacity) apply to the whole view, as does
		// data-center="false", which keeps the meshes at their absolute positions
		// instead of centring the first frame on the coverslip, and data-rotation
		// (degrees, counterclockwise from above) which turns meshes and coverslip
		// about the vertical axis. In that mode data-coverslip-scale sizes the slab
		// relative to the scene footprint. data-axes-size sets the orientation
		// marker size in pixels (default 120). The camera zoom comes from the
		// --viewer-zoom CSS custom property on the view element. Playback
		// attributes (data-autoplay, data-frame-interval) are read by setupPlaybackUi.
		const datasets = readDatasets(wrapper, {
			basePath: elem.dataset.basepath || 'data/meshes/mesh',
			meshCount: numberAttr(elem, 'meshcount'),
			startIndex: numberAttr(elem, 'startindex'),
			vertexColors: elem.dataset.vertexcolors === 'true'
		});
		// data-sequences on the view element renders several sequences at once in
		// the single (implicit) dataset; a data-datasets entry can carry its own
		// `sequences` list instead of a basePath.
		const sequences = readJsonList(elem.dataset.sequences, 'data-sequences', (seq) => seq && typeof seq.basePath === 'string');
		if (sequences && !wrapper?.dataset.datasets) datasets[0].sequences = sequences;
		const first = datasets[0];

		const ui = setupPlaybackUi(wrapper, elem);

		// Create the view
		const view = new MeshTimeseriesView({
			elem,
			basePath: first.basePath,
			meshCount: first.meshCount,
			startIndex: first.startIndex,
			sequences: first.sequences,
			centerFrames: elem.dataset.center !== 'false',
			sceneRotation: numberAttr(elem, 'rotation'),
			coverslipScale: numberAttr(elem, 'coverslipScale'),
			axesSize: numberAttr(elem, 'axesSize'),
			enableControls: true,
			useVertexColors: !!first.vertexColors,
			showCoverslip: elem.dataset.coverslip !== 'false',
			coverslipSize: numberAttr(elem, 'coverslipSize'),
			coverslipOpacity: numberAttr(elem, 'coverslipOpacity'),
			// Timeline range and progress total follow the resolved count
			onCountResolved: (count) => ui.setFrameCount(count),
			...ui.callbacks
		});

		// Wire up dataset arrows (no-op with a single dataset)
		wireDatasetNav(wrapper, datasets, (ds) => {
			ui.reset();
			view.setDataset({
				basePath: ds.basePath,
				meshCount: ds.meshCount,
				startIndex: ds.startIndex,
				sequences: ds.sequences,
				useVertexColors: !!ds.vertexColors
			});
		});

		ui.wire(view);
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

		const ui = setupPlaybackUi(wrapper, elem);

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
			coverslipOpacity: numberAttr(elem, 'coverslipOpacity'),
			// Timeline range and progress total follow the metadata frame count
			onMetadataLoaded: (metadata) => ui.setFrameCount(metadata.frameCount),
			...ui.callbacks
		});

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
			ui.reset();
			applyDatasetPresets(ds);
			if (applyContrast) applyContrast(contrastMaxSlider);
			if (applyGamma) applyGamma();
			view.setDataset({ basePath: ds.basePath });
		});

		ui.wire(view);
	});
}

/**
 * Wire a number input (frames per second) to a view's playback speed.
 * The box only takes whole numbers within its min/max: other characters are
 * refused as they are typed, the speed is applied on every keystroke / spinner
 * click, and the text is snapped to the value in use when the box loses focus.
 * @param {HTMLInputElement} input
 * @param {{setFps: Function}} view
 */
function wireFpsInput(input, view) {
	const min = Math.round(parseFloat(input.min)) || 1;
	const max = Math.round(parseFloat(input.max)) || 60;
	const maxDigits = String(max).length;

	// Whole number in range for the box's current text, or null while it is empty
	const read = () => {
		const fps = Math.round(parseFloat(input.value));
		return Number.isFinite(fps) ? Math.min(max, Math.max(min, fps)) : null;
	};

	// A number input would otherwise take a decimal point, a sign and an exponent
	input.addEventListener('beforeinput', (e) => {
		if (e.data != null && /\D/.test(e.data)) e.preventDefault();
	});

	input.addEventListener('input', () => {
		const fps = read();
		if (fps === null) return;
		// Anything that cannot be a value in range (pasted fraction, extra digit)
		// is replaced straight away; shorter text is left alone while typing
		if (!/^\d+$/.test(input.value) || input.value.length > maxDigits) {
			input.value = String(fps);
		}
		view.setFps(fps);
	});

	input.addEventListener('change', () => {
		// Empty box: fall back to the markup's starting value
		const fps = read() ?? (Math.round(parseFloat(input.defaultValue)) || min);
		view.setFps(fps);
		input.value = String(fps);
	});

	// Initialise the view from the input's starting value
	const initial = read();
	if (initial !== null) view.setFps(initial);
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
