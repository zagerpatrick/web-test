#!/usr/bin/env node
/**
 * Upload the datasets in public/data/ to the Cloudflare R2 bucket that serves them.
 *
 *   npm run data:push                    upload new and changed files
 *   npm run data:push -- --dry-run       show what would happen, change nothing
 *   npm run data:push -- --all           upload every file again, changed or not
 *   npm run data:push -- --prune         also delete bucket files whose local file is gone
 *   npm run data:push -- <folder> ...    only look at these dataset folders
 *
 * The bucket mirrors public/data/: `public/data/<folder>/<file>` becomes the object
 * `<folder>/<file>`, served at `<VITE_DATA_BASE_URL><folder>/<file>` (see
 * .env.production and src/js/dataSource.js).
 *
 * Uploads go through Wrangler, Cloudflare's CLI, which npx downloads on first use.
 * Log in once with `npx wrangler login`.
 *
 * Wrangler cannot list a bucket, so the script keeps its own record of what it has
 * uploaded in .r2-sync-state.json (not in git). Files whose content matches the
 * record are skipped. Deleting the record is harmless: the next run uploads
 * everything again. Files changed in the bucket by other means (the dashboard, say)
 * are not noticed; use --all to put the bucket back in step with the local folder.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The R2 bucket connected to the data host named in .env.production
const BUCKET = 'patrickzager-data';
const DATA_DIR = join(ROOT, 'public', 'data');
const STATE_FILE = join(ROOT, '.r2-sync-state.json');

// Pinned because `r2 bulk put` is still marked experimental in Wrangler: a newer
// release could change it. Check the command still works when raising the version.
const WRANGLER = 'wrangler@4.159.0';

// How long browsers and Cloudflare's cache may reuse a file before asking again.
// A file replaced under the same name can be served stale for this long (4 hours)
// unless the cache is purged. Changing this only affects files uploaded afterwards;
// run with --all to apply it to everything.
const CACHE_CONTROL = 'public, max-age=14400';

const CONTENT_TYPES = {
	'.glb': 'model/gltf-binary',
	'.gltf': 'model/gltf+json',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm'
};
// Everything else, including the `.bin.br` volume frames. Those are stored and
// served as opaque bytes (no Content-Encoding), because the viewer decompresses
// them itself.
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

// One Wrangler run uploads at most this many files, so an interrupted push only
// repeats a small batch.
const BATCH_SIZE = 250;

// Cloudflare's API allows 1,200 requests per five minutes and every file is one
// request. Wrangler paces itself within a run but not across runs, so the batches
// are spaced out here.
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_BUDGET = 1000;

// Wrangler puts the key into the request URL as it is, so keep to characters that
// are safe there (and in the URLs the site fetches).
const SAFE_KEY = /^[A-Za-z0-9._\-/]+$/;

const HELP = `Upload the datasets in public/data/ to the R2 bucket "${BUCKET}".

Usage: npm run data:push -- [options] [folder ...]

  folder       Only look at these dataset folders (names inside public/data/)
  --dry-run    Show what would be uploaded or deleted, change nothing
  --all        Upload every file again, changed or not
  --prune      Also delete bucket files whose local file no longer exists
  --help       Show this message`;

function parseArgs(argv) {
	const options = { dryRun: false, all: false, prune: false, help: false, folders: [] };
	for (const arg of argv) {
		if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
		else if (arg === '--all') options.all = true;
		else if (arg === '--prune') options.prune = true;
		else if (arg === '--help' || arg === '-h') options.help = true;
		else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}\n\n${HELP}`);
		// Accept `meshes_21_20260731`, `meshes_21_20260731/` and `public/data/meshes_21_20260731`
		else options.folders.push(basename(arg));
	}
	return options;
}

/**
 * Every file under `dir`, skipping dotfiles such as .DS_Store
 * @param {string} dir
 * @returns {Promise<string[]>} Absolute paths
 */
async function listFiles(dir) {
	const files = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(path)));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

function sha256(file) {
	return new Promise((resolvePromise, reject) => {
		const hash = createHash('sha256');
		createReadStream(file)
			.on('data', (chunk) => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolvePromise(hash.digest('hex')));
	});
}

/** Dataset folder of an object key (its first path segment), or '' for a top-level file */
function folderOf(key) {
	const slash = key.indexOf('/');
	return slash === -1 ? '' : key.slice(0, slash);
}

function formatSize(bytes) {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

function plural(count, noun) {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The record of previous uploads: `{ bucket, objects: { key: { sha256, size, mtimeMs } } }` */
async function loadState() {
	try {
		const state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
		// A record made for another bucket says nothing about this one
		if (state?.bucket === BUCKET && state.objects && typeof state.objects === 'object') return state;
	} catch (error) {
		if (error.code !== 'ENOENT') console.warn(`Ignoring unreadable ${basename(STATE_FILE)}: ${error.message}`);
	}
	return { bucket: BUCKET, objects: {} };
}

async function saveState(state) {
	const sorted = Object.fromEntries(Object.entries(state.objects).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	await writeFile(STATE_FILE, `${JSON.stringify({ bucket: BUCKET, objects: sorted }, null, '\t')}\n`);
}

/** Run Wrangler with its output shown; rejects if it exits with an error */
function wrangler(args) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn('npx', ['--yes', WRANGLER, ...args], { cwd: ROOT, stdio: 'inherit' });
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolvePromise();
			else {
				reject(new Error(`Wrangler failed (wrangler ${args.slice(0, 3).join(' ')}, exit code ${code}). ` +
					'If it said you are not authenticated, run "npx wrangler login" and try again.'));
			}
		});
	});
}

// Upload times and sizes of the batches sent in the last RATE_WINDOW_MS
const recentBatches = [];

/** Wait, if needed, until `count` more uploads fit in Cloudflare's rate limit window */
async function waitForRateLimit(count) {
	for (;;) {
		const cutoff = Date.now() - RATE_WINDOW_MS;
		while (recentBatches.length > 0 && recentBatches[0].time <= cutoff) recentBatches.shift();
		const used = recentBatches.reduce((sum, batch) => sum + batch.count, 0);
		if (recentBatches.length === 0 || used + count <= RATE_BUDGET) return;
		const waitMs = recentBatches[0].time + RATE_WINDOW_MS - Date.now() + 1000;
		console.log(`Pausing ${Math.ceil(waitMs / 1000)} s to stay under Cloudflare's API rate limit...`);
		await new Promise((done) => setTimeout(done, waitMs));
	}
}

/**
 * Upload one batch of files that share a content type
 * @param {Object[]} entries - `{ key, file }`
 * @param {string} contentType
 */
async function uploadBatch(entries, contentType) {
	await waitForRateLimit(entries.length);
	const tempDir = await mkdtemp(join(tmpdir(), 'r2-sync-'));
	try {
		const listFile = join(tempDir, 'files.json');
		await writeFile(listFile, JSON.stringify(entries.map(({ key, file }) => ({ key, file }))));
		await wrangler([
			'r2', 'bulk', 'put', BUCKET,
			'--filename', listFile,
			'--content-type', contentType,
			'--cache-control', CACHE_CONTROL,
			'--remote',
			'--force'
		]);
	} finally {
		recentBatches.push({ time: Date.now(), count: entries.length });
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(HELP);
		return;
	}
	if (!existsSync(DATA_DIR)) {
		throw new Error(`${relative(ROOT, DATA_DIR)}/ does not exist, so there is nothing to upload.`);
	}

	const state = await loadState();
	const inScope = (key) => options.folders.length === 0 || options.folders.includes(folderOf(key));

	// Local files, keyed the way the bucket names them
	const local = [];
	for (const file of await listFiles(DATA_DIR)) {
		const key = relative(DATA_DIR, file).split(sep).join('/');
		if (!inScope(key)) continue;
		if (!SAFE_KEY.test(key)) {
			throw new Error(`"${key}" has characters that are not safe in a URL. ` +
				'Rename it to use only letters, digits, ".", "_" and "-".');
		}
		const { size, mtimeMs } = await stat(file);
		local.push({ key, file, size, mtimeMs });
	}
	local.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const localKeys = new Set(local.map((entry) => entry.key));

	for (const folder of options.folders) {
		const known = local.some((entry) => folderOf(entry.key) === folder) ||
			Object.keys(state.objects).some((key) => folderOf(key) === folder);
		if (!known) throw new Error(`No dataset folder named "${folder}" in ${relative(ROOT, DATA_DIR)}/.`);
	}

	// Work out which files differ from what was last uploaded. A file whose size and
	// modification time match the record is taken as unchanged without reading it.
	const toUpload = [];
	let recordChanged = false;
	for (const entry of local) {
		const previous = state.objects[entry.key];
		const untouched = previous && previous.size === entry.size && previous.mtimeMs === entry.mtimeMs;
		entry.sha256 = untouched ? previous.sha256 : await sha256(entry.file);
		if (options.all || !previous || previous.sha256 !== entry.sha256) {
			toUpload.push(entry);
		} else if (!untouched) {
			// Same content with a new timestamp: note it so the file is not read again next time
			previous.mtimeMs = entry.mtimeMs;
			recordChanged = true;
		}
	}
	if (recordChanged && !options.dryRun) await saveState(state);

	// Files this script uploaded earlier that no longer exist locally
	const stale = Object.keys(state.objects).filter((key) => inScope(key) && !localKeys.has(key)).sort();

	const uploadBytes = toUpload.reduce((sum, entry) => sum + entry.size, 0);
	console.log(`${plural(local.length, 'local file')} in ${relative(ROOT, DATA_DIR)}/, ` +
		(toUpload.length > 0
			? `${toUpload.length} to upload (${formatSize(uploadBytes)}) to bucket "${BUCKET}".`
			: `none to upload to bucket "${BUCKET}".`));

	// What is about to go up, per dataset folder
	const perFolder = new Map();
	for (const entry of toUpload) {
		const folder = folderOf(entry.key) || '(top level)';
		const total = perFolder.get(folder) || { count: 0, bytes: 0 };
		total.count++;
		total.bytes += entry.size;
		perFolder.set(folder, total);
	}
	const nameWidth = Math.max(0, ...Array.from(perFolder.keys(), (folder) => folder.length));
	for (const [folder, { count, bytes }] of perFolder) {
		console.log(`  ${folder.padEnd(nameWidth)}  ${plural(count, 'file').padStart(10)}  ${formatSize(bytes).padStart(9)}`);
	}

	// A bulk upload sets one content type for all its files, so send each type separately
	const byType = new Map();
	for (const entry of toUpload) {
		const contentType = CONTENT_TYPES[extname(entry.key).toLowerCase()] || DEFAULT_CONTENT_TYPE;
		if (!byType.has(contentType)) byType.set(contentType, []);
		byType.get(contentType).push(entry);
	}

	if (!options.dryRun) {
		for (const [contentType, entries] of byType) {
			for (let start = 0; start < entries.length; start += BATCH_SIZE) {
				const batch = entries.slice(start, start + BATCH_SIZE);
				console.log(`\nUploading ${plural(batch.length, 'file')} as ${contentType} ` +
					`(${start + batch.length} of ${entries.length})...`);
				await uploadBatch(batch, contentType);
				// Record each batch as it lands so an interrupted push resumes where it stopped
				for (const { key, sha256: hash, size, mtimeMs } of batch) {
					state.objects[key] = { sha256: hash, size, mtimeMs };
				}
				await saveState(state);
			}
		}
	}

	if (stale.length > 0) {
		console.log(`\n${plural(stale.length, 'file')} in the bucket no longer ${stale.length === 1 ? 'exists' : 'exist'} locally:`);
		for (const key of stale.slice(0, 20)) console.log(`  ${key}`);
		if (stale.length > 20) console.log(`  ... and ${stale.length - 20} more`);

		if (!options.prune) {
			console.log('Run again with --prune to delete them from the bucket.');
		} else if (local.length === 0 && options.folders.length === 0) {
			// An empty or misplaced data folder must not be able to empty the bucket
			throw new Error(`${relative(ROOT, DATA_DIR)}/ has no files, so --prune would delete everything. ` +
				'Name the folders to delete if that is what you want.');
		} else if (!options.dryRun) {
			for (const key of stale) {
				await wrangler(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote', '--force']);
				delete state.objects[key];
				await saveState(state);
			}
			console.log(`Deleted ${plural(stale.length, 'file')} from the bucket.`);
		}
	}

	if (options.dryRun) {
		console.log('\nDry run: nothing was changed.');
	} else if (toUpload.length > 0) {
		console.log(`\nUploaded ${plural(toUpload.length, 'file')}. New files are live straight away; ` +
			'a file replaced under the same name can be served from cache for up to 4 hours ' +
			'(purge the cache in the Cloudflare dashboard to refresh it sooner).');
	} else {
		console.log('\nThe bucket is up to date.');
	}
}

main().catch((error) => {
	console.error(`\n${error.message}`);
	process.exitCode = 1;
});
