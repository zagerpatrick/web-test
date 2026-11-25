/**
 * Download one data file as bytes. Shared by the page and the mesh load workers,
 * so both agree on what counts as a missing file.
 * @param {string} url
 * @param {AbortSignal} [signal] - Cancels the download
 * @returns {Promise<ArrayBuffer>} Rejects when the file is missing or the download fails
 */
export async function fetchFile(url, signal) {
	const response = await fetch(url, { signal });
	// A missing file is a 404, or the HTML page that Vite's dev / preview servers
	// answer with instead (HTTP 200)
	const type = response.headers.get('content-type') || '';
	if (!response.ok || type.includes('text/html')) {
		throw new Error(response.ok ? 'not found (the server returned an HTML page instead)'
			: `${response.status} ${response.statusText}`.trim());
	}
	return response.arrayBuffer();
}
