/**
 * Give back the memory behind typed arrays that are no longer needed, now, instead
 * of leaving it to the garbage collector.
 *
 * The viewers churn through large arrays: decoded mesh frames and volume frames
 * are made in workers, handed to the page, used for a while and dropped. A
 * collector frees such memory when it next runs, and decides when to run from how
 * much has been allocated since the last time. Safari's does not count a buffer
 * that arrived from a worker, so on a page that allocates little else it never
 * gets round to it: the dropped frames pile up (hundreds of MB within seconds of
 * playback on a phone) until the system ends the page. Detaching a buffer frees
 * its memory on the spot in every browser.
 *
 * Only call this for data nothing will read again: afterwards every typed array
 * on these buffers is empty.
 * @param {Iterable<ArrayBuffer>} buffers
 */
export function releaseBuffers(buffers) {
	for (const buffer of buffers) {
		// Shared memory and already detached buffers are left alone
		if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) continue;
		try {
			if (typeof buffer.transfer === 'function') {
				// Moves the contents into a new buffer of length 0, i.e. discards them
				buffer.transfer(0);
			} else if (typeof structuredClone === 'function') {
				// Older browsers: hand the contents to a clone that is dropped at once.
				// That still waits for a collection, but a cheap one for a brand new object.
				structuredClone(buffer, { transfer: [buffer] });
			}
		} catch (error) {
			// A buffer that cannot be detached (WebAssembly memory, say) stays with the collector
		}
	}
}
