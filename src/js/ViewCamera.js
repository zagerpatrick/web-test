import * as THREE from 'three';

/**
 * ViewCamera.js - The orthographic camera shared by the mesh and volume views
 *
 * Both views look at their scene through an orthographic camera, so parallel
 * edges stay parallel on screen and match the orientation marker. The frustum
 * is 2 units tall (the shared renderer widens it to the view's aspect), which
 * makes `camera.zoom` the reciprocal of half the visible height in scene units.
 * The camera's distance from its orbit target changes the size of nothing; it
 * only has to keep the scene between the near and far planes.
 */

/** Camera presets: direction from the orbit target to the camera, and the up vector */
export const VIEW_PRESETS = {
	iso:    { pos: [1, -1, 1], up: [0, 0, 1] },
	top:    { pos: [0, 0, 1], up: [0, 1, 0] },
	bottom: { pos: [0, 0, -1], up: [0, -1, 0] },
	front:  { pos: [0, -1, 0], up: [0, 0, 1] },
	back:   { pos: [0, 1, 0], up: [0, 0, 1] },
	left:   { pos: [-1, 0, 0], up: [0, 0, 1] },
	right:  { pos: [1, 0, 0], up: [0, 0, 1] }
};

/** Margin left around whatever the default zoom is fitted to (1 = edge to edge) */
export const FIT_PADDING = 1.08;

/** Duration of an animated camera move, in ms */
const ANIMATION_MS = 700;

/**
 * Create a view camera
 * @param {number} distance - Distance it will be kept at from its orbit target
 * @returns {THREE.OrthographicCamera}
 */
export function createViewCamera(distance) {
	return new THREE.OrthographicCamera(-1, 1, 1, -1, distance / 1000, 2 * distance);
}

/**
 * @param {THREE.OrthographicCamera} camera
 * @param {number} zoom
 */
export function setZoom(camera, zoom) {
	camera.zoom = zoom;
	camera.updateProjectionMatrix();
}

/**
 * Give a camera the aspect ratio of its view: the frustum keeps its height and
 * is widened (or narrowed) about its centre
 * @param {THREE.OrthographicCamera} camera
 * @param {number} aspect - View width / height
 */
export function setCameraAspect(camera, aspect) {
	const halfWidth = (camera.top - camera.bottom) / 2 * aspect;
	camera.left = -halfWidth;
	camera.right = halfWidth;
	camera.updateProjectionMatrix();
}

/**
 * Put a camera in a preset, looking at its orbit target
 * @param {THREE.OrthographicCamera} camera
 * @param {THREE.Vector3} pivot - The orbit target
 * @param {string} presetName - Key of VIEW_PRESETS
 * @param {number} distance - Camera distance from the orbit target
 */
export function poseCamera(camera, pivot, presetName, distance) {
	const { pos, up } = VIEW_PRESETS[presetName];
	camera.position.set(...pos).normalize().multiplyScalar(distance).add(pivot);
	camera.up.set(...up);
	camera.lookAt(pivot);
}

/**
 * Orientation a camera has in a preset
 * @param {string} presetName - Key of VIEW_PRESETS
 * @returns {THREE.Quaternion}
 */
export function presetOrientation(presetName) {
	const { pos, up } = VIEW_PRESETS[presetName];
	const rotation = new THREE.Matrix4().lookAt(
		new THREE.Vector3(...pos), new THREE.Vector3(), new THREE.Vector3(...up)
	);
	return new THREE.Quaternion().setFromRotationMatrix(rotation);
}

/**
 * Zoom at which a rectangle centred on the view axis just fits the view, with
 * the fit margin around it
 * @param {THREE.OrthographicCamera} camera
 * @param {number} halfWidth - Half the rectangle's extent across the screen
 * @param {number} halfHeight - Half the rectangle's extent up the screen
 * @returns {number}
 */
export function fitZoom(camera, halfWidth, halfHeight) {
	// At zoom 1 the view is 2 units tall and 2 * aspect wide
	const aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
	return Math.min(aspect / halfWidth, 1 / halfHeight) / FIT_PADDING;
}

/**
 * Bring a view's controls in step with its element after a resize: re-measure
 * the element, and make a pan follow the pointer one to one. TrackballControls
 * scales an orthographic pan by the eye distance over the element width, and its
 * damping spreads each move over several frames that add up to
 * 1 / dynamicDampingFactor of it, so the speed that cancels both depends on the
 * width the controls measured.
 * @param {TrackballControls|null} controls
 * @param {number} distance - Camera distance from the orbit target
 */
export function syncControls(controls, distance) {
	if (!controls) return;
	controls.handleResize();
	if (controls.screen.width > 0) {
		controls.panSpeed = controls.dynamicDampingFactor * controls.screen.width / distance;
	}
}

/**
 * Animate a camera to a preset, swinging it around its orbit target while the
 * target glides to its end point and the zoom eases to its end value
 * @param {THREE.OrthographicCamera} camera
 * @param {THREE.Vector3} pivot - The live orbit target (shared with the controls); moved in place
 * @param {number} distance - Camera distance from the orbit target
 * @param {Object} end
 * @param {string} end.preset - Key of VIEW_PRESETS to end in
 * @param {THREE.Vector3} [end.pivot] - Point to end up orbiting; the current target when omitted
 * @param {number} [end.zoom] - Zoom to ease to; the current zoom when omitted
 * @param {Function} isCurrent - Returns false once the animation is superseded or its view disposed
 * @param {Function} [onDone] - Called after the last step
 */
export function animateCamera(camera, pivot, distance, end, isCurrent, onDone) {
	const { pos, up } = VIEW_PRESETS[end.preset];
	const endDir = new THREE.Vector3(...pos).normalize();
	const endUp = new THREE.Vector3(...up);
	const endPivot = (end.pivot ?? pivot).clone();
	const endZoom = end.zoom ?? camera.zoom;

	const startDir = camera.position.clone().sub(pivot).normalize();
	const startUp = camera.up.clone();
	const startPivot = pivot.clone();
	const startZoom = camera.zoom;
	const startTime = performance.now();

	// Rotation that carries the start direction onto the end direction
	const turn = new THREE.Quaternion().setFromUnitVectors(startDir, endDir);
	const identity = new THREE.Quaternion();
	const partTurn = new THREE.Quaternion();
	const dir = new THREE.Vector3();

	const animate = () => {
		if (!isCurrent()) return;

		const t = Math.min((performance.now() - startTime) / ANIMATION_MS, 1);
		const done = t === 1;
		const eased = 1 - Math.pow(1 - t, 3);  // ease-out cubic

		if (done) {
			// The last step lands on the end state exactly
			dir.copy(endDir);
			camera.up.copy(endUp);
			pivot.copy(endPivot);
			setZoom(camera, endZoom);
		} else {
			dir.copy(startDir).applyQuaternion(partTurn.slerpQuaternions(identity, turn, eased));
			camera.up.lerpVectors(startUp, endUp, eased).normalize();
			pivot.lerpVectors(startPivot, endPivot, eased);
			// Eased by ratio, so it reads as a steady change in magnification
			setZoom(camera, startZoom * Math.pow(endZoom / startZoom, eased));
		}
		camera.position.copy(pivot).addScaledVector(dir, distance);
		camera.lookAt(pivot);

		if (!done) {
			requestAnimationFrame(animate);
		} else if (onDone) {
			onDone();
		}
	};

	requestAnimationFrame(animate);
}
