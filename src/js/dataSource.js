/**
 * Where the dataset files (meshes, volumes) are fetched from.
 *
 * Pages name their datasets by a logical path under `data/`, such as
 * `data/meshes_21_20260731/mesh`. The files are not part of the site build: they
 * are hosted in a Cloudflare R2 bucket whose public URL is given at build time by
 * the VITE_DATA_BASE_URL environment variable (set for production builds in
 * `.env.production`). The bucket holds the contents of the local `public/data/`
 * folder, so `data/<folder>/<file>` lives at `<VITE_DATA_BASE_URL><folder>/<file>`.
 *
 * When the variable is unset, as under `npm run dev`, the paths are left alone and
 * resolve to the local copy in `public/data/`.
 */

// Prefix of every logical dataset path, and the local folder under public/
const LOCAL_DATA_PREFIX = 'data/';

const configuredBase = (import.meta.env.VITE_DATA_BASE_URL || '').trim();

/** Base URL of the data host, ending in a slash; the local folder when none is configured */
export const DATA_BASE_URL = configuredBase ? configuredBase.replace(/\/*$/, '/') : LOCAL_DATA_PREFIX;

/**
 * Map a logical dataset path to the URL it is fetched from.
 * Anything that does not start with `data/` (an absolute URL, a path elsewhere on
 * the site) is returned unchanged.
 * @param {string} path - e.g. `data/volumes_21_20260731/` or `data/meshes_21_20260731/mesh`
 * @returns {string}
 */
export function resolveDataPath(path) {
	if (typeof path !== 'string' || !path.startsWith(LOCAL_DATA_PREFIX)) return path;
	return DATA_BASE_URL + path.slice(LOCAL_DATA_PREFIX.length);
}
