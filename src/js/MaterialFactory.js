import * as THREE from 'three';
import { SURFACE_GREY, LIGHT, LIGHT_DIR_VIEW, AO_STRENGTH, AO_COLOR } from './RenderStyle.js';
import { computeSmoothNormals } from './SmoothNormals.js';

/**
 * MaterialFactory - napari / MeshVis-style surface shading for the mesh views
 *
 * One ShaderMaterial reproduces vispy's ShadingFilter (Blinn-Phong, two-sided
 * smooth normals, camera-relative light, raw display colours) together with
 * napari_ao's ambient-occlusion overlay, in a single pass.
 *
 * Per-vertex AO travels in the alpha channel of the GLB vertex colours as
 * visibility (alpha = 1 - ao), written by scripts/ply_to_glb.py. Files without
 * baked AO have alpha 1 and simply get no darkening.
 */

const surfaceVertexShader = /* glsl */`
varying vec3 vNormalView;
varying vec4 vColor4;

void main() {
	vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
	vNormalView = normalMatrix * normal;
#if defined( USE_COLOR_ALPHA )
	vColor4 = color;
#elif defined( USE_COLOR )
	vColor4 = vec4(color, 1.0);
#else
	vColor4 = vec4(1.0);
#endif
	gl_Position = projectionMatrix * mvPosition;
}
`;

const surfaceFragmentShader = /* glsl */`
uniform vec3 uBaseColor;
uniform float uUseVertexColor;
uniform float uAmbient;
uniform float uDiffuse;
uniform float uSpecular;
uniform float uShininess;
uniform vec3 uLightDirView;
uniform float uAoStrength;
uniform vec3 uAoColor;

varying vec3 vNormalView;
varying vec4 vColor4;

void main() {
	vec3 base = mix(uBaseColor, vColor4.rgb, uUseVertexColor);
	// Alpha stores visibility: 1.0 = fully exposed (or no AO baked), 0.0 = fully occluded
	float ao = 1.0 - vColor4.a;

	// Two-sided smooth normal, as in vispy's shading filter
	vec3 n = normalize(vNormalView);
	n = gl_FrontFacing ? n : -n;

	vec3 L = normalize(uLightDirView);   // toward the light (fixed relative to the camera)
	vec3 V = vec3(0.0, 0.0, 1.0);        // toward the eye (the camera is orthographic)

	// Blinn-Phong: I = base * (Ia + Id * n.L) + Is * (n.H)^shininess, specular only where lit
	float diffuse = max(dot(n, L), 0.0);
	float specular = 0.0;
	if (diffuse > 0.0 && uShininess > 0.0) {
		vec3 H = normalize(L + V);
		specular = pow(clamp(dot(n, H), 0.0, 1.0), uShininess);
	}
	vec3 lit = base * (uAmbient + uDiffuse * diffuse) + uSpecular * specular;

	// AO overlay: lerp the lit colour toward the AO tint by strength * occlusion
	vec3 color = mix(lit, uAoColor, uAoStrength * ao);
	gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * Create the shared surface material of one view
 * @param {Object} options
 * @param {boolean} options.useVertexColors - Colour from the GLB vertex colours instead of the flat grey
 * @param {number[]} options.baseColor - Raw RGB 0-1 used when vertex colours are off (default: #BBBBBB)
 * @param {number} options.aoStrength - Blend fraction toward the AO tint at full occlusion (default: 0.6)
 * @returns {THREE.ShaderMaterial}
 */
export function createSurfaceMaterial(options = {}) {
	const baseColor = options.baseColor ?? SURFACE_GREY;
	return new THREE.ShaderMaterial({
		uniforms: {
			uBaseColor: { value: new THREE.Vector3(baseColor[0], baseColor[1], baseColor[2]) },
			uUseVertexColor: { value: options.useVertexColors ? 1.0 : 0.0 },
			uAmbient: { value: LIGHT.ambient },
			uDiffuse: { value: LIGHT.diffuse },
			uSpecular: { value: LIGHT.specular },
			uShininess: { value: LIGHT.shininess },
			uLightDirView: { value: new THREE.Vector3(...LIGHT_DIR_VIEW).normalize() },
			uAoStrength: { value: options.aoStrength ?? AO_STRENGTH },
			uAoColor: { value: new THREE.Vector3(AO_COLOR[0], AO_COLOR[1], AO_COLOR[2]) }
		},
		vertexShader: surfaceVertexShader,
		fragmentShader: surfaceFragmentShader,
		// vertexColors makes three.js declare `attribute vec4 color` for RGBA geometry
		vertexColors: true,
		side: THREE.DoubleSide
	});
}

/**
 * Switch a surface material between vertex colours and the flat base colour
 * @param {THREE.ShaderMaterial} material
 * @param {boolean} useVertexColors
 */
export function setUseVertexColors(material, useVertexColors) {
	if (material?.uniforms?.uUseVertexColor) {
		material.uniforms.uUseVertexColor.value = useVertexColors ? 1.0 : 0.0;
	}
}

/**
 * Assign the view's surface material to every mesh of a loaded GLTF scene,
 * computing smooth normals and disposing the loader-created materials.
 * @param {THREE.Object3D} root
 * @param {THREE.ShaderMaterial} material
 */
export function applySurfaceMaterial(root, material) {
	root.traverse((child) => {
		if (!child.isMesh) return;
		if (child.geometry) computeSmoothNormals(child.geometry);
		const old = child.material;
		if (Array.isArray(old)) {
			old.forEach((m) => m.dispose());
		} else if (old) {
			old.dispose();
		}
		child.material = material;
	});
}
