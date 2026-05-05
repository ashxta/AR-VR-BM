import * as THREE from 'three';

let isGameRunning = false;
let isARMode = false;
let score = 0;
let bestScore = 0;
let gameLevel = 1;
let currentLane = 1;
let gameTime = 0;
let touchStartX = 0;
let touchEndX = 0;

const lanes = [-2, 0, 2];
const baseSpeed = 0.05;
const baseObstacleSpeed = 0.06;
const levelDuration = 10000;

const hud = document.getElementById('hud');
const scoreElement = document.getElementById('score');
const bestScoreElement = document.getElementById('best-score');
const levelElement = document.getElementById('game-level');
const speedElement = document.getElementById('game-speed');
const startScreen = document.getElementById('start-screen');
const gameOverScreen = document.getElementById('game-over-screen');
const finalScoreElement = document.getElementById('final-score');
const startBtn = document.getElementById('start-btn');
const restartBtn = document.getElementById('restart-btn');
const arStartBtn = document.getElementById('ar-start-btn');
const arContainer = document.getElementById('arContainer');

try {
  bestScore = parseInt(localStorage.getItem('neonRunnerBest')) || 0;
  if (bestScoreElement) bestScoreElement.innerText = 'BEST: ' + bestScore;
} catch (error) {
  console.warn('Local storage blocked. High scores will not save.');
}

let scene, camera, renderer;
let playerCar, gridHelper;
let worldGroup;        // FIX: parent for the whole game world — lets us scale/place it in AR
let backgroundGroup;   // FIX: sun + stars; hidden in AR so the camera feed shows through
let obstacles = [];
let collectibles = [];
let timeMultiplier = 1.0;
let clock;

// Save desktop look so we can restore it after AR session ends
let savedSceneBackground = null;
let savedSceneFog = null;

function initScene() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.015);
  scene.background = new THREE.Color(0x000011);

  savedSceneBackground = scene.background;
  savedSceneFog = scene.fog;

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 3, 7);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.xr.enabled = true;          // FIX: enable XR up front, not after a session is requested
  arContainer.appendChild(renderer.domElement);

  clock = new THREE.Clock();

  buildGameScene();

  window.addEventListener('resize', () => {
    if (renderer.xr.isPresenting) return;  // FIX: don't fight XR for viewport control
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // FIX: setAnimationLoop is the single render loop that handles both desktop AND XR.
  // Three.js automatically uses session.requestAnimationFrame when an XR session is active.
  renderer.setAnimationLoop(animate);
}

async function startARMode() {
  if (!navigator.xr) {
    alert('WebXR not available in this browser.');
    return;
  }

  try {
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) {
      alert('Immersive AR is not supported on this device.');
      return;
    }

    // FIX: hit-test isn't actually used in this game — don't require it.
    // dom-overlay and local-floor are optional so we don't fail on devices that lack them.
    const session = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: ['dom-overlay', 'local-floor'],
      domOverlay: { root: document.body },
    });

    isARMode = true;
    renderer.xr.setReferenceSpaceType('local'); // FIX: 'local', not 'viewer' — world stays put
    await renderer.xr.setSession(session);

    // FIX: clear the background so the camera passthrough is visible
    scene.background = null;
    scene.fog = null;
    renderer.setClearColor(0x000000, 0);

    // FIX: hide the giant cyberpunk sky — in AR it just blocks the camera feed
    if (backgroundGroup) backgroundGroup.visible = false;

    // FIX: rescale and reposition the game world for AR.
    // 1 unit = 1 meter in AR, so a 300m road is absurd. Shrink to ~10cm per unit
    // and place the world ~1.5m in front of the player at floor level.
    worldGroup.scale.setScalar(0.1);
    worldGroup.position.set(0, -0.5, -1.5);

    // Restore everything when the AR session ends
    session.addEventListener('end', () => {
      isARMode = false;
      worldGroup.scale.setScalar(1);
      worldGroup.position.set(0, 0, 0);
      if (backgroundGroup) backgroundGroup.visible = true;
      scene.background = savedSceneBackground;
      scene.fog = savedSceneFog;
      renderer.setClearColor(0x000000, 1);
      if (hud) hud.style.display = 'none';
      if (startScreen) startScreen.style.display = 'flex';
      isGameRunning = false;
    });

    startScreen.style.display = 'none';
    hud.style.display = 'block';

    startGameAR();
  } catch (err) {
    console.error('AR error:', err);
    alert('Could not start AR: ' + (err && err.message ? err.message : err));
  }
}

function startGameAR() {
  isGameRunning = true;
  score = 0;
  gameLevel = 1;
  gameTime = 0;
  timeMultiplier = 1.0;
  currentLane = 1;

  if (scoreElement) scoreElement.innerText = 'SCORE: 0';
  if (levelElement) levelElement.innerText = 'LEVEL: 1';
  if (speedElement) speedElement.innerText = 'SPEED: 1.0x';

  playerCar.position.set(lanes[1], -0.75, 4);

  obstacles.forEach((obs) => worldGroup.remove(obs));
  obstacles.length = 0;
  collectibles.forEach((col) => worldGroup.remove(col));
  collectibles.length = 0;

  clock.getDelta();

  spawnObstacles();
  spawnCollectibles();
}

function buildGameScene() {
  // FIX: everything game-related goes into worldGroup so we can scale/place it as one unit in AR
  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  backgroundGroup = new THREE.Group();
  worldGroup.add(backgroundGroup);

  // Neon Sun
  const sunGeometry = new THREE.SphereGeometry(18, 64, 64);
  const sunMaterial = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      void main() {
        vec3 coreColor = vec3(1.0, 0.9, 0.0);
        vec3 rimColor = vec3(1.0, 0.1, 0.4);
        vec3 color = mix(coreColor, rimColor, vUv.y);
        float linePattern = step(0.15, mod(vUv.y * 20.0, 1.0));
        color *= linePattern;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  const neonSun = new THREE.Mesh(sunGeometry, sunMaterial);
  neonSun.position.set(0, 8, -120);
  backgroundGroup.add(neonSun);

  // Starfield
  const starGeometry = new THREE.BufferGeometry();
  const starCoords = [];
  for (let i = 0; i < 800; i++) {
    starCoords.push(
      THREE.MathUtils.randFloatSpread(300),
      THREE.MathUtils.randFloat(5, 80),
      THREE.MathUtils.randFloat(-200, 10)
    );
  }
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starCoords, 3));
  const starMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 0.3, transparent: true, opacity: 0.8 });
  backgroundGroup.add(new THREE.Points(starGeometry, starMaterial));

  // Road surface
  const roadGeometry = new THREE.PlaneGeometry(6, 300);
  const roadMaterial = new THREE.MeshBasicMaterial({ color: 0x0a0a1a });
  const road = new THREE.Mesh(roadGeometry, roadMaterial);
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, -1.01, -150);
  worldGroup.add(road);

  // Grid
  gridHelper = new THREE.GridHelper(300, 150, 0xff00ff, 0x45a29e);
  gridHelper.position.y = -1;
  worldGroup.add(gridHelper);

  // Lane dividers
  for (let i = 0; i < 2; i++) {
    const dividerGeom = new THREE.PlaneGeometry(0.05, 300);
    const dividerMat = new THREE.MeshBasicMaterial({ color: 0x66fcf1, transparent: true, opacity: 0.4 });
    const divider = new THREE.Mesh(dividerGeom, dividerMat);
    divider.rotation.x = -Math.PI / 2;
    divider.position.set(i === 0 ? -1 : 1, -0.99, -150);
    worldGroup.add(divider);
  }

  // Player Car
  const carGeometry = new THREE.BoxGeometry(1, 0.5, 2);
  const carMaterial = new THREE.MeshBasicMaterial({ color: 0x66fcf1 });
  playerCar = new THREE.Mesh(carGeometry, carMaterial);
  playerCar.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(carGeometry),
    new THREE.LineBasicMaterial({ color: 0xffffff })
  ));
  playerCar.position.set(lanes[1], -0.75, 4);
  worldGroup.add(playerCar);

  // Headlights
  const leftLight = new THREE.PointLight(0x66fcf1, 1.5, 6);
  leftLight.position.set(-0.4, 0, -1.1);
  playerCar.add(leftLight);

  const rightLight = new THREE.PointLight(0x66fcf1, 1.5, 6);
  rightLight.position.set(0.4, 0, -1.1);
  playerCar.add(rightLight);
}

function updateGameLogic(delta) {
  if (!isGameRunning) return;

  gameTime += delta * 1000;

  const newLevel = Math.floor(gameTime / levelDuration) + 1;
  if (newLevel > gameLevel) {
    gameLevel = newLevel;
    timeMultiplier = 1.0 + (gameLevel - 1) * 0.15;
    if (levelElement) levelElement.innerText = 'LEVEL: ' + gameLevel;
    if (speedElement) speedElement.innerText = 'SPEED: ' + timeMultiplier.toFixed(1) + 'x';
  }

  const currentSpeed = baseSpeed * timeMultiplier;
  const currentObstacleSpeed = baseObstacleSpeed * timeMultiplier;

  playerCar.position.x += (lanes[currentLane] - playerCar.position.x) * 0.15;

  gridHelper.position.z += currentSpeed;
  if (gridHelper.position.z > 2) gridHelper.position.z = 0;

  const gameObjects = [...obstacles, ...collectibles];
  for (let i = gameObjects.length - 1; i >= 0; i--) {
    const obj = gameObjects[i];
    obj.position.z += currentObstacleSpeed;

    const isCollectible = collectibles.includes(obj);

    if (isCollectible) obj.rotation.y += 0.05;

    // Collision check
    if (
      obj.position.z > playerCar.position.z - 1.5 &&
      obj.position.z < playerCar.position.z + 1.5 &&
      Math.abs(obj.position.x - playerCar.position.x) < 0.8
    ) {
      if (isCollectible) {
        score += 100;
        if (scoreElement) scoreElement.innerText = 'SCORE: ' + score;
        worldGroup.remove(obj);
        collectibles.splice(collectibles.indexOf(obj), 1);
      } else {
        triggerGameOver();
        return;
      }
      continue;
    }

    // FIX: in AR the camera is wherever the player's phone is, not at a fixed z.
    // Use the player car as the despawn anchor in both modes (it's the same in desktop too).
    const zThreshold = playerCar.position.z + 5;
    if (obj.position.z > zThreshold) {
      worldGroup.remove(obj);
      if (!isCollectible) {
        obstacles.splice(obstacles.indexOf(obj), 1);
        score += 10;
        if (scoreElement) scoreElement.innerText = 'SCORE: ' + score;
      } else {
        collectibles.splice(collectibles.indexOf(obj), 1);
      }
    }
  }
}

// FIX: a single animation loop. setAnimationLoop drives it in both desktop and XR.
// Three.js automatically swaps in the XR camera when a session is active — we don't
// have to write a separate animateXR function.
function animate() {
  const delta = clock.getDelta();
  updateGameLogic(delta);
  renderer.render(scene, camera);
}

function startGame() {
  isGameRunning = true;
  score = 0;
  gameLevel = 1;
  gameTime = 0;
  timeMultiplier = 1.0;
  currentLane = 1;

  if (scoreElement) scoreElement.innerText = 'SCORE: 0';
  if (levelElement) levelElement.innerText = 'LEVEL: 1';
  if (speedElement) speedElement.innerText = 'SPEED: 1.0x';

  if (startScreen) startScreen.style.display = 'none';
  if (gameOverScreen) gameOverScreen.style.display = 'none';
  if (hud) hud.style.display = 'block';

  playerCar.position.x = lanes[1];

  obstacles.forEach((obs) => worldGroup.remove(obs));
  obstacles.length = 0;
  collectibles.forEach((col) => worldGroup.remove(col));
  collectibles.length = 0;

  clock.getDelta();

  spawnObstacles();
  spawnCollectibles();
}

function triggerGameOver() {
  isGameRunning = false;

  if (score > bestScore) {
    bestScore = score;
    try {
      localStorage.setItem('neonRunnerBest', bestScore);
    } catch (e) {}
    if (bestScoreElement) bestScoreElement.innerText = 'BEST: ' + bestScore;
  }

  if (hud) hud.style.display = 'none';
  if (gameOverScreen) gameOverScreen.style.display = 'flex';
  if (finalScoreElement) finalScoreElement.innerText = 'FINAL SCORE: ' + score;
}

function spawnObstacles() {
  if (!isGameRunning) return;

  const obstacleTypes = [
    { geom: new THREE.BoxGeometry(1, 1, 1), color: 0xff00ff },
    { geom: new THREE.BoxGeometry(0.5, 2, 0.5), color: 0x00ccff },
    { geom: new THREE.BoxGeometry(2.5, 0.8, 1), color: 0xff5500 },
  ];

  const type = obstacleTypes[Math.floor(Math.random() * obstacleTypes.length)];
  const material = new THREE.MeshBasicMaterial({ color: type.color });
  const obstacle = new THREE.Mesh(type.geom, material);
  obstacle.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(type.geom),
    new THREE.LineBasicMaterial({ color: 0xffffff })
  ));

  const randomLane = Math.floor(Math.random() * lanes.length);
  obstacle.position.set(lanes[randomLane], type.geom.parameters.height / 2 - 1, -80);
  worldGroup.add(obstacle);
  obstacles.push(obstacle);

  const delay = Math.max(400, 1000 - (gameLevel - 1) * 50);
  setTimeout(spawnObstacles, delay);
}

function spawnCollectibles() {
  if (!isGameRunning) return;

  if (Math.random() > 0.35) {
    setTimeout(spawnCollectibles, 3000);
    return;
  }

  const coinGeometry = new THREE.TorusGeometry(0.5, 0.15, 16, 64);
  const coinMaterial = new THREE.MeshBasicMaterial({ color: 0xffd700, wireframe: true });
  const coin = new THREE.Mesh(coinGeometry, coinMaterial);

  let randomLane = Math.floor(Math.random() * lanes.length);
  const isOccupied = obstacles.some((obs) => obs.position.x === lanes[randomLane] && obs.position.z < -75);
  if (isOccupied) randomLane = (randomLane + 1) % lanes.length;

  coin.position.set(lanes[randomLane], 0, -80);
  worldGroup.add(coin);
  collectibles.push(coin);

  setTimeout(spawnCollectibles, 3000);
}

function moveLeft() {
  if (!isGameRunning) return;
  if (currentLane > 0) currentLane--;
}

function moveRight() {
  if (!isGameRunning) return;
  if (currentLane < 2) currentLane++;
}

document.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].screenX;
});

document.addEventListener('touchend', (e) => {
  touchEndX = e.changedTouches[0].screenX;
  const diff = touchStartX - touchEndX;
  if (Math.abs(diff) > 50) {
    if (diff > 0) moveRight();
    else moveLeft();
  }
});

document.getElementById('btn-left').addEventListener('click', moveLeft);
document.getElementById('btn-right').addEventListener('click', moveRight);

window.addEventListener('keydown', (event) => {
  if (!isGameRunning) return;
  if (event.key === 'ArrowLeft') moveLeft();
  if (event.key === 'ArrowRight') moveRight();
});

if (startBtn) startBtn.addEventListener('click', startGame);
if (restartBtn) restartBtn.addEventListener('click', startGame);

if (arStartBtn) {
  arStartBtn.addEventListener('click', startARMode);
  // FIX: also feature-detect immersive-ar specifically, not just navigator.xr
  if (!navigator.xr) {
    arStartBtn.style.display = 'none';
  } else {
    navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
      if (!supported) arStartBtn.style.display = 'none';
    }).catch(() => {
      arStartBtn.style.display = 'none';
    });
  }
}

initScene();
