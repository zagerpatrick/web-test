import * as THREE from 'three';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// Scene

const scene = new THREE.Scene();

// Camera

const camera = new THREE.PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.1, 20000 );

// Renderer

const renderer = new THREE.WebGLRenderer();
renderer.setSize( window.innerWidth/1.5, window.innerHeight/1.5 );
document.body.appendChild( renderer.domElement );

// Controls

const controls = new OrbitControls( camera, renderer.domElement );

// Camera Position

camera.position.set( 150, 150, 150 );
// Controls.update() must be called after any manual changes to the camera's transform
controls.update();

// Lights

var ambientLight = new THREE.AmbientLight( 0x404040 );
scene.add( ambientLight );
             
var directionalLight = new THREE.DirectionalLight( 0xffffff );
directionalLight.position.set( 0, 100, 100 ).normalize();
scene.add( directionalLight );

var directionalLight2 = new THREE.DirectionalLight( 0xffffff );
directionalLight2.position.set( 0, -100, -100 ).normalize();
scene.add( directionalLight2 );		

var directionalLight3 = new THREE.DirectionalLight( 0xffffff, 0.5 );
directionalLight3.position.set( 300, 0, 0 ).normalize();
scene.add( directionalLight3 );		

// Define files for import

// Define the base file name and file extension
var baseFileName = "mesh";
var fileExtension = ".glb";

// Define the number of files to iterate through
var numberOfFiles = 90 + 1; // Change this to the desired number of files

// Function to pad numbers with leading zeros to a specified length
function pad(num, size) {
    var s = num + "";
    while (s.length < size) s = "0" + s;
    return s;
}

// Create an array to hold meshes
var glbFiles = [];

for (var i = 1; i < numberOfFiles; i++) {

    // Construct the file name
    var fileName = baseFileName + pad( i, 4 ) + fileExtension;

    // Append to array
    glbFiles.push( fileName );
}

// Import Files

// Create an array to hold the loaded meshes
var meshes = [];

// Create a loader for GLB files
var loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

// GLTFLoader.setMeshoptDecoder()

// Function to load GLB files sequentially
function loadGLBFilesSequentially(index) {
    return new Promise(function(resolve, reject) {
        if (index >= glbFiles.length) {
            resolve();
            return;
        }

        loader.load(
            glbFiles[index],
            function(gltf) {

                // Add the loaded model to the scene
                scene.add(gltf.scene);

                // Hide the model initially
                gltf.scene.visible = false;

                // Push the loaded mesh to the meshes array
                meshes.push(gltf.scene);

                // Load the next GLB file recursively
                loadGLBFilesSequentially(index + 1).then(resolve);
            },
            // onProgress callback function
            function(xhr) {
                // console.log((xhr.loaded / xhr.total * 100) + '% loaded');
            },
            // onError callback function
            function(error) {
                console.error('An error happened', error);
                reject(error);
            }
        );
    });
}

// Load GLB files sequentially starting from index 0
loadGLBFilesSequentially(0).then(function() {
    // All files are loaded, create the slider and start rendering
    
    // Create a slider

    var slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "89";
    slider.step = "1";
    slider.value = "0";
    document.body.appendChild(slider);

    ////
    // Get references to the slider and the number display span
    var sliderValueSpan = document.getElementById("sliderValue");

    // Add event listener to the slider to update the number display
    slider.addEventListener("input", function() {
        sliderValueSpan.textContent = slider.value;
    });

    // Initial update of the number display
    sliderValueSpan.textContent = slider.value;
    document.body.appendChild(slider);
    ////

    // console.log("meshes:", meshes);

    // Render

    function animate() {
        requestAnimationFrame( animate );
        
        // Required if controls.enableDamping or controls.autoRotate are set to true
        // controls.update();
        
        // Update mesh visibility based on slider value
        var index = parseInt(slider.value);
        for (var i = 0; i < meshes.length; i++) {
            meshes[i].visible = (i === index);
        }
        renderer.render( scene, camera );
    }
    animate();
});










