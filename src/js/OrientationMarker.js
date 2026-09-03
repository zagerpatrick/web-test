import * as THREE from 'three';

// Embedded Helvetiker Black (extra bold) font subset for X, Y, Z characters
const helvetikerBlackFont = {
	glyphs: {
		X: {
			ha: 750,
			o: 'm 0 0 l 240 310 l 0 717 l 200 717 l 330 460 l 460 717 l 660 717 l 420 310 l 660 0 l 460 0 l 330 160 l 200 0 l 0 0 z'
		},
		Y: {
			ha: 750,
			o: 'm 0 717 l 200 717 l 330 420 l 460 717 l 660 717 l 430 280 l 430 0 l 230 0 l 230 280 l 0 717 z'
		},
		Z: {
			ha: 700,
			o: 'm 0 0 l 0 160 l 350 557 l 30 557 l 30 717 l 620 717 l 620 557 l 270 160 l 640 160 l 640 0 l 0 0 z'
		}
	},
	familyName: 'Helvetiker Black',
	resolution: 1000,
	boundingBox: { yMin: -218, xMin: -50, yMax: 931, xMax: 1232 },
	underlineThickness: 50
};

// Default charcoal color for labels
const DEFAULT_LABEL_COLOR = 0x363636;

/**
 * Parse font outline commands to create a Shape
 * @param {string} outline - Font outline commands
 * @param {number} scale - Scale factor
 * @returns {THREE.Shape}
 */
function parseOutline(outline, scale) {
	const shape = new THREE.Shape();
	const commands = outline.split(' ');

	let i = 0;
	while (i < commands.length) {
		const cmd = commands[i];
		switch (cmd) {
			case 'm':
				shape.moveTo(parseFloat(commands[i + 1]) * scale, parseFloat(commands[i + 2]) * scale);
				i += 3;
				break;
			case 'l':
				shape.lineTo(parseFloat(commands[i + 1]) * scale, parseFloat(commands[i + 2]) * scale);
				i += 3;
				break;
			case 'q':
				shape.quadraticCurveTo(
					parseFloat(commands[i + 1]) * scale, parseFloat(commands[i + 2]) * scale,
					parseFloat(commands[i + 3]) * scale, parseFloat(commands[i + 4]) * scale
				);
				i += 5;
				break;
			case 'z':
				shape.closePath();
				i += 1;
				break;
			default:
				i += 1;
		}
	}

	return shape;
}

/**
 * Create text mesh for a label (extra bold, extruded for thickness)
 * @param {string} char - Character to render
 * @param {number} size - Size of the label
 * @param {number} color - Color for the label
 * @returns {THREE.Mesh}
 */
function createLabelMesh(char, size, color) {
	const glyph = helvetikerBlackFont.glyphs[char];
	if (!glyph) {
		console.warn(`Glyph for "${char}" not found`);
		return null;
	}

	const scale = size / helvetikerBlackFont.resolution;
	const shape = parseOutline(glyph.o, scale);

	// Use ExtrudeGeometry for a bolder, 3D look
	const geometry = new THREE.ExtrudeGeometry(shape, {
		depth: size * 0.15,
		bevelEnabled: false
	});
	geometry.computeBoundingBox();

	// Center the geometry
	const bbox = geometry.boundingBox;
	const centerX = (bbox.max.x + bbox.min.x) / 2;
	const centerY = (bbox.max.y + bbox.min.y) / 2;
	const centerZ = (bbox.max.z + bbox.min.z) / 2;
	geometry.translate(-centerX, -centerY, -centerZ);

	const material = new THREE.MeshBasicMaterial({
		color: color,
		toneMapped: false
	});

	return new THREE.Mesh(geometry, material);
}

/**
 * OrientationMarker - CAD-style axes indicator that shows scene orientation
 *
 * Renders a small axes indicator in the corner of the view that rotates
 * with the camera to show current orientation.
 */
export default class OrientationMarker {
	/**
	 * Create a new orientation marker
	 * @param {Object} options - Configuration options
	 * @param {number} options.size - Size of the marker viewport in pixels (default: 120)
	 * @param {number} options.axisLength - Length of axis lines (default: 1.9)
	 * @param {number} options.labelColor - Color for axis labels (default: 0x363636)
	 */
	constructor(options = {}) {
		this.size = options.size || 120;
		this.axisLength = options.axisLength || 1.9;
		this.labelColor = options.labelColor !== undefined ? options.labelColor : DEFAULT_LABEL_COLOR;

		this.scene = null;
		this.camera = null;
		this.axesGroup = null;
		this.labels = [];
		this.labelOffset = 0;
		this.visible = true;

		this._create();
	}

	/**
	 * Build the axes, cones, labels, and sphere
	 * @private
	 */
	_create() {
		this.scene = new THREE.Scene();
		this.scene.background = null;

		// Orthographic camera
		const frustumSize = 4.0;
		this.camera = new THREE.OrthographicCamera(
			-frustumSize, frustumSize,
			frustumSize, -frustumSize,
			0.1, 10
		);
		this.camera.position.set(0, 0, 5);
		this.camera.lookAt(0, 0, 0);

		// Group for axes (will be rotated)
		this.axesGroup = new THREE.Group();
		this.scene.add(this.axesGroup);

		// Axis colors
		const colors = {
			x: 0xff4500,
			y: 0x32cd32,
			z: 0x3b9eff
		};

		const axisLength = this.axisLength;
		const coneHeight = 0.85;
		const coneRadius = 0.42;
		const cylinderRadius = 0.24;
		const sphereRadius = 0.55;
		const labelSize = 1.3;
		this.labelOffset = axisLength + coneHeight + 0.5;

		// Central sphere
		const sphereGeometry = new THREE.SphereGeometry(sphereRadius, 16, 16);
		const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0xaaaaaa, toneMapped: false });
		const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
		this.axesGroup.add(sphere);

		// Axes definition
		const axes = [
			{ dir: new THREE.Vector3(1, 0, 0), color: colors.x, label: 'X' },
			{ dir: new THREE.Vector3(0, 1, 0), color: colors.y, label: 'Y' },
			{ dir: new THREE.Vector3(0, 0, 1), color: colors.z, label: 'Z' }
		];

		this.labels = [];

		for (const axis of axes) {
			// Cylinder for axis shaft
			const cylinderGeometry = new THREE.CylinderGeometry(
				cylinderRadius, cylinderRadius, axisLength, 8
			);
			const cylinderMaterial = new THREE.MeshBasicMaterial({ color: axis.color, toneMapped: false });
			const cylinder = new THREE.Mesh(cylinderGeometry, cylinderMaterial);

			cylinder.position.copy(axis.dir.clone().multiplyScalar(axisLength / 2));

			if (axis.label === 'X') {
				cylinder.rotation.z = -Math.PI / 2;
			} else if (axis.label === 'Z') {
				cylinder.rotation.x = Math.PI / 2;
			}

			this.axesGroup.add(cylinder);

			// Cone arrowhead
			const coneGeometry = new THREE.ConeGeometry(coneRadius, coneHeight, 12);
			const coneMaterial = new THREE.MeshBasicMaterial({ color: axis.color, toneMapped: false });
			const cone = new THREE.Mesh(coneGeometry, coneMaterial);

			cone.position.copy(axis.dir.clone().multiplyScalar(axisLength + coneHeight / 2));

			if (axis.label === 'X') {
				cone.rotation.z = -Math.PI / 2;
			} else if (axis.label === 'Z') {
				cone.rotation.x = Math.PI / 2;
			}

			this.axesGroup.add(cone);

			// Text label - added to scene directly, not axesGroup (for billboarding)
			const labelMesh = createLabelMesh(axis.label, labelSize, this.labelColor);
			if (labelMesh) {
				labelMesh.userData.axisDir = axis.dir.clone();
				this.scene.add(labelMesh);
				this.labels.push(labelMesh);
			}
		}
	}

	/**
	 * Sync the marker's orientation with a camera
	 * @param {THREE.Camera} sourceCamera - The camera to sync with
	 */
	syncWithCamera(sourceCamera) {
		// Rotate axes group
		this.axesGroup.quaternion.copy(sourceCamera.quaternion).invert();

		// Update label positions to follow rotated axes, but keep labels facing camera
		const rotatedDir = new THREE.Vector3();
		for (const label of this.labels) {
			rotatedDir.copy(label.userData.axisDir);
			rotatedDir.applyQuaternion(this.axesGroup.quaternion);
			label.position.copy(rotatedDir.multiplyScalar(this.labelOffset));
			// Labels always face the camera (no rotation)
			label.quaternion.identity();
		}
	}

	/**
	 * Set marker visibility
	 * @param {boolean} visible
	 */
	setVisible(visible) {
		this.visible = visible;
	}

	/**
	 * Check if marker is visible
	 * @returns {boolean}
	 */
	isVisible() {
		return this.visible;
	}

	/**
	 * Get the size of the marker viewport
	 * @returns {number}
	 */
	getSize() {
		return this.size;
	}

	/**
	 * Dispose of all resources
	 */
	dispose() {
		if (!this.scene) return;

		this.scene.traverse((object) => {
			if (object.geometry) {
				object.geometry.dispose();
			}
			if (object.material) {
				if (Array.isArray(object.material)) {
					object.material.forEach(m => m.dispose());
				} else {
					object.material.dispose();
				}
			}
		});

		this.scene = null;
		this.camera = null;
		this.axesGroup = null;
		this.labels = [];
	}
}
