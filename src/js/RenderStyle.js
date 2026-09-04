/**
 * RenderStyle.js - Palette and shading constants shared by every view
 *
 * These reproduce the napari / MeshVis reference renderer: a high-ambient
 * Blinn-Phong surface lit from a camera-relative direction, per-vertex ambient
 * occlusion blended toward a warm dark tint, and a translucent coverslip slab
 * with a thick outline. Colours are raw display values (no colour management),
 * exactly as vispy writes them to the framebuffer.
 */

/** Flat grey for unlabelled meshes (MeshVis / Paul Tol grey #BBBBBB), raw RGB 0-1 */
export const SURFACE_GREY = [187 / 255, 187 / 255, 187 / 255];

/** vispy ShadingFilter light intensities set by napari_render.init_3d_shading */
export const LIGHT = {
	ambient: 0.75,
	diffuse: 0.30,
	specular: 0.20,
	shininess: 1.0
};

/**
 * Direction TO the light in view space (x right, y up, z toward the viewer).
 * napari re-derives its light from the camera on every move; the visible result
 * lights surfaces facing screen-left, screen-up and the viewer.
 */
export const LIGHT_DIR_VIEW = [-1, 1, 1];

/** Ambient occlusion overlay (napari_ao.install_ao_overlay): blend fraction at full occlusion and target tint */
export const AO_STRENGTH = 0.6;
export const AO_COLOR = [0.15, 0.13, 0.11];

/**
 * Coverslip (substrate) defaults; lengths are in mesh units (voxels).
 * The slab is centred on the origin in XY and each view shifts its whole
 * timeseries by one fixed offset so the FIRST frame sits centred on the slab
 * (later frames keep their registered motion relative to it).
 */
export const COVERSLIP = {
	bodyColor: 0xd3d3d3,
	edgeColorLight: 0x000000,  // outline on a light background
	edgeColorDark: 0xffffff,   // outline on a dark background
	padSize: 250,              // square XY footprint under the cell in the mesh view
	footprintScale: 1.25,      // volume view: slab footprint relative to the volume box
	thickness: 12,
	edgeRadius: 1.6,
	radialSegments: 8,
	meshBodyOpacity: 0.5,      // on white: slab reads as a light grey plate (#EA)
	volumeBodyOpacity: 0.12    // on black: faint plate so the MIP keeps its contrast
};

/** Viewer backgrounds: white for meshes, black for volumes (reference light / dark phases) */
export const BACKGROUND = {
	mesh: 0xffffff,
	volume: 0x000000
};
