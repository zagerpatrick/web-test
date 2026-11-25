/**
 * How much memory the viewers may plan on, decided once per page load.
 *
 * A desktop browser lets a page take several GB, and the viewers use that: every
 * mesh frame of a dataset stays decoded in memory, so playback and scrubbing never
 * wait. With two mesh viewers and a volume viewer the project page holds more than
 * 1 GB that way, plus the copies on the GPU.
 *
 * A phone or tablet cannot afford that. iOS ends the process of a tab once it holds
 * around 1.5 GB (less on devices with less RAM, and sooner when the device as a
 * whole is short of memory) and Safari reloads the page, which fills up and is
 * ended again: the page seems to load for a few seconds and then refresh, over and
 * over. On those devices the viewers therefore follow a low-memory plan:
 *
 * - a mesh viewer keeps the downloaded files of its dataset (small) but only a
 *   window of decoded frames around the one on show, and decodes the others again
 *   as playback reaches them (see MeshTimeseriesView, `residentBytes`);
 * - a volume viewer keeps fewer decoded frames;
 * - both worker pools are smaller;
 * - a viewer does not start downloading until it is about to scroll into view.
 *
 * The plan can be forced with `?memory=low` or `?memory=full` in the page address,
 * to try the low-memory viewers on a desktop or the full ones on a tablet with RAM
 * to spare.
 */

const MB = 1024 * 1024;

/**
 * Whether this device should be treated as short of memory
 * @returns {boolean}
 */
function detectLowMemory() {
	const override = new URLSearchParams(window.location.search).get('memory');
	if (override === 'low') return true;
	if (override === 'full') return false;

	// Phones and tablets, whatever their RAM: their browsers cap a page well below
	// it. An iPad asks for desktop sites and then calls itself a Mac, which its
	// touch screen gives away.
	const agent = navigator.userAgent || '';
	if (/iPhone|iPad|iPod|Android/i.test(agent)) return true;
	if (/Macintosh/i.test(agent) && navigator.maxTouchPoints > 1) return true;

	// Chromium reports the device's RAM in GB (rounded down, 8 at most)
	return typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
}

const lowMemory = detectLowMemory();

// A pool of at most this many workers, leaving one core to the page
const workersUpTo = (most) => Math.max(1, Math.min(most, (navigator.hardwareConcurrency || 2) - 1));

/**
 * @property {boolean} lowMemory - The low-memory plan is in force
 * @property {number} meshResidentBytes - Decoded geometry a mesh viewer keeps in
 *   memory (the `residentBytes` option of MeshTimeseriesView); Infinity keeps every frame
 * @property {number|undefined} volumeDecodedFrames - Decoded frames a volume viewer
 *   keeps, about 10 MB each (`maxDecodedFrames`); undefined leaves the viewer's default
 * @property {number} meshWorkers - Workers of the mesh load pool
 * @property {number} volumeWorkers - Workers of the volume decode pool
 * @property {boolean} loadWhenNear - Viewers wait to load until they are near the screen
 */
export const memoryPlan = Object.freeze(lowMemory ? {
	lowMemory: true,
	meshResidentBytes: 64 * MB,
	volumeDecodedFrames: 5,
	meshWorkers: workersUpTo(2),
	volumeWorkers: workersUpTo(2),
	loadWhenNear: true
} : {
	lowMemory: false,
	meshResidentBytes: Infinity,
	volumeDecodedFrames: undefined,
	meshWorkers: workersUpTo(3),
	volumeWorkers: workersUpTo(3),
	loadWhenNear: false
});
