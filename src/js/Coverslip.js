import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COVERSLIP } from './RenderStyle.js';

/**
 * Coverslip - translucent slab with a thick outline (the MeshVis substrate)
 *
 * A box body (unlit, translucent, double-sided) plus twelve cylinders, one per
 * box edge, and eight corner spheres merged into a single opaque outline mesh.
 * The group's local origin is the centre of the box; setTop() places the top
 * face at a given Z in the parent's space.
 */
export default class Coverslip {
	/**
	 * @param {Object} options
	 * @param {number} options.sizeX - Footprint along X (default: 200)
	 * @param {number} options.sizeY - Footprint along Y (default: 200)
	 * @param {number} options.thickness - Slab thickness along Z (default: 12)
	 * @param {number} options.edgeRadius - Radius of the outline cylinders (default: 1.6)
	 * @param {number} options.radialSegments - Cylinder resolution (default: 8)
	 * @param {number} options.bodyColor - Slab colour (default: 0xd3d3d3)
	 * @param {number} options.bodyOpacity - Slab opacity 0-1 (default: 0.5)
	 * @param {number} options.edgeColor - Outline colour (default: black)
	 */
	constructor(options = {}) {
		this.sizeX = options.sizeX ?? COVERSLIP.padSize;
		this.sizeY = options.sizeY ?? COVERSLIP.padSize;
		this.thickness = options.thickness ?? COVERSLIP.thickness;
		this.edgeRadius = options.edgeRadius ?? COVERSLIP.edgeRadius;
		const radialSegments = options.radialSegments ?? COVERSLIP.radialSegments;

		this.group = new THREE.Group();
		this.group.name = 'coverslip';

		// Translucent body, unlit like napari's shading="none" surface. Front faces
		// only: the box is convex, so exactly one layer is visible from outside and the
		// slab keeps the same opacity from every angle (a double-sided box stacks its
		// front and back faces to 1 - (1 - opacity)^2).
		this.bodyMaterial = new THREE.MeshBasicMaterial({
			color: options.bodyColor ?? COVERSLIP.bodyColor,
			transparent: true,
			opacity: options.bodyOpacity ?? COVERSLIP.meshBodyOpacity,
			side: THREE.FrontSide,
			depthWrite: false,
			toneMapped: false
		});
		this.body = new THREE.Mesh(
			new THREE.BoxGeometry(this.sizeX, this.sizeY, this.thickness),
			this.bodyMaterial
		);
		this.body.renderOrder = 0;
		this.group.add(this.body);

		// Opaque outline: WebGL ignores line width, so the edges are thin cylinders
		this.edgeMaterial = new THREE.MeshBasicMaterial({
			color: options.edgeColor ?? COVERSLIP.edgeColorLight,
			toneMapped: false
		});
		this.edges = new THREE.Mesh(this._buildEdgeGeometry(radialSegments), this.edgeMaterial);
		this.group.add(this.edges);
	}

	/**
	 * Build one merged geometry holding the 12 edge cylinders and 8 corner spheres
	 * @private
	 * @param {number} radialSegments
	 * @returns {THREE.BufferGeometry}
	 */
	_buildEdgeGeometry(radialSegments) {
		const hx = this.sizeX / 2;
		const hy = this.sizeY / 2;
		const hz = this.thickness / 2;
		const corners = [
			[-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],  // bottom face
			[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]       // top face
		].map((c) => new THREE.Vector3(c[0], c[1], c[2]));
		const edgePairs = [
			[0, 1], [1, 2], [2, 3], [3, 0],  // bottom face
			[4, 5], [5, 6], [6, 7], [7, 4],  // top face
			[0, 4], [1, 5], [2, 6], [3, 7]   // risers
		];

		const cylinderAxis = new THREE.Vector3(0, 1, 0);  // CylinderGeometry runs along +Y
		const parts = [];

		for (const [a, b] of edgePairs) {
			const p0 = corners[a];
			const p1 = corners[b];
			const direction = new THREE.Vector3().subVectors(p1, p0);
			const length = direction.length();
			direction.normalize();

			const geometry = new THREE.CylinderGeometry(this.edgeRadius, this.edgeRadius, length, radialSegments);
			geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(cylinderAxis, direction));
			const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
			geometry.translate(mid.x, mid.y, mid.z);
			parts.push(geometry);
		}

		// Spheres close the gaps where three cylinders meet
		for (const corner of corners) {
			const geometry = new THREE.SphereGeometry(this.edgeRadius, radialSegments, Math.max(4, radialSegments / 2));
			geometry.translate(corner.x, corner.y, corner.z);
			parts.push(geometry);
		}

		const merged = mergeGeometries(parts, false);
		parts.forEach((g) => g.dispose());
		return merged;
	}

	/**
	 * Place the top face of the slab at z (in the parent's coordinates)
	 * @param {number} z
	 */
	setTop(z) {
		this.group.position.z = z - this.thickness / 2;
	}

	/**
	 * Centre the slab under a point in XY
	 * @param {number} x
	 * @param {number} y
	 */
	setCenterXY(x, y) {
		this.group.position.x = x;
		this.group.position.y = y;
	}

	/**
	 * @param {number} opacity - Body opacity 0-1
	 */
	setBodyOpacity(opacity) {
		this.bodyMaterial.opacity = opacity;
	}

	/**
	 * @param {number|string|THREE.Color} color - Outline colour
	 */
	setEdgeColor(color) {
		this.edgeMaterial.color.set(color);
	}

	/**
	 * @param {boolean} visible
	 */
	setVisible(visible) {
		this.group.visible = visible;
	}

	/**
	 * @returns {boolean}
	 */
	isVisible() {
		return this.group.visible;
	}

	/**
	 * Remove from the scene and release GPU resources
	 */
	dispose() {
		if (this.group.parent) this.group.parent.remove(this.group);
		this.body.geometry.dispose();
		this.edges.geometry.dispose();
		this.bodyMaterial.dispose();
		this.edgeMaterial.dispose();
	}
}
