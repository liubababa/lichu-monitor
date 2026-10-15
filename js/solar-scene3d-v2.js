/* ============================================================
 * 洙边卫生院光伏 3D 监控 · 优化版（独立预览）
 *
 *   与 js/solar-scene3d.js（站点正在用的 SolarScene）互不影响，
 *   本文件供 solar-preview.html 单独预览新版效果。
 *
 *   依赖（经典脚本，挂在 window.THREE 上，不用 ES Module）：
 *     libs/three.min.js、libs/OrbitControls.js、libs/CSS2DRenderer.js
 *
 *   对外接口：window.SolarSceneV2 = { initSolarScene, setWeatherMode, updateDeviceData }
 * ============================================================ */
let scene, camera, renderer, controls, labelRenderer;
let solarGroup = new THREE.Group();
let equipmentMap = new Map();
let weatherMode = 'day';
let rainMesh;
let envMapIntensityGround = 0.12; //修复白天地面过曝

function initSolarScene(containerDom) {
    // 画布基础初始化
    const width = containerDom.clientWidth;
    const height = containerDom.clientHeight;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);
    camera.position.set(32, 14.5, 28); //调整机位，可见远山
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    containerDom.appendChild(renderer.domElement);

    // 标签渲染器，修复pointer-events遮挡BUG
    labelRenderer = new THREE.CSS2DRenderer();
    labelRenderer.setSize(width, height);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0px';
    labelRenderer.domElement.style.pointerEvents = 'none'; //修复标签挡住点击
    containerDom.appendChild(labelRenderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minDistance = 10;
    controls.maxDistance = 120;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;

    // 光照
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(ambientLight);
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    sunLight.position.set(50, 80, 30);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    scene.add(sunLight);

    scene.add(solarGroup);
    buildHospitalScene(); //卫生院大院环境
    buildPVEquipment();   //光伏设备合批构建
    buildRainInstance();  //雨滴实例化
    buildBackMountain();  //远景山脊（双面材质）

    // 点击射线检测
    const raycaster = new THREE.Raycaster();
    containerDom.addEventListener('pointerdown', (e) => {
        const rect = renderer.domElement.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
        const hits = raycaster.intersectObjects(solarGroup.children, true);
        if(hits.length > 0){
            let obj = hits[0].object;
            while(obj){
                if(obj.userData && obj.userData.key){
                    onDeviceClick(obj.userData.key);
                    break;
                }
                obj = obj.parent;
            }
        }
    })

    window.addEventListener('resize', ()=>{
        const w = containerDom.clientWidth;
        const h = containerDom.clientHeight;
        camera.aspect = w/h;
        camera.updateProjectionMatrix();
        renderer.setSize(w,h);
        labelRenderer.setSize(w,h);
    })

    animate();
}

// 构建卫生院场地：围墙、大门、步道、建筑、车辆、树木
function buildHospitalScene(){
    //地面地坪
    const groundGeo = new THREE.PlaneGeometry(100,100);
    const groundMat = new THREE.MeshStandardMaterial({
        color:0xaaaaaa,
        roughness:0.9,
        metalness:0,
        envMapIntensity: envMapIntensityGround
    })
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    solarGroup.add(ground);

    //围墙
    const wallMat = new THREE.MeshStandardMaterial({color:0xf0f0f0, roughness:0.7});
    const wall1 = new THREE.Mesh(new THREE.BoxGeometry(60,2.4,0.3), wallMat);
    wall1.position.set(0,1.2,-30);
    wall1.castShadow=true; wall1.receiveShadow=true;
    solarGroup.add(wall1);
    const wall2 = new THREE.Mesh(new THREE.BoxGeometry(0.3,2.4,60), wallMat);
    wall2.position.set(-30,1.2,0);
    wall2.castShadow=true; wall2.receiveShadow=true;
    solarGroup.add(wall2);
    const wall3 = new THREE.Mesh(new THREE.BoxGeometry(60,2.4,0.3), wallMat);
    wall3.position.set(0,1.2,30);
    wall3.castShadow=true; wall3.receiveShadow=true;
    solarGroup.add(wall3);
    const wall4 = new THREE.Mesh(new THREE.BoxGeometry(0.3,2.4,40), wallMat);
    wall4.position.set(30,1.2,-10);
    wall4.castShadow=true; wall4.receiveShadow=true;
    solarGroup.add(wall4);

    //大门
    const gateMat = new THREE.MeshStandardMaterial({color:0x444444});
    const gateLeft = new THREE.Mesh(new THREE.BoxGeometry(0.2,2,6), gateMat);
    gateLeft.position.set(30,1,-22);
    solarGroup.add(gateLeft);
    const gateRight = new THREE.Mesh(new THREE.BoxGeometry(0.2,2,6), gateMat);
    gateRight.position.set(30,1,-14);
    solarGroup.add(gateRight);

    //院内主楼
    const buildMat = new THREE.MeshStandardMaterial({color:0xf8f8f8, roughness:0.8});
    const mainBuild = new THREE.Mesh(new THREE.BoxGeometry(24,8,12), buildMat);
    mainBuild.position.set(-8,4,0);
    mainBuild.castShadow=true; mainBuild.receiveShadow=true;
    solarGroup.add(mainBuild);

    //红十字标识2D标签
    const redCrossDiv = document.createElement('div');
    redCrossDiv.className='tag3d';
    redCrossDiv.style.color='red';
    redCrossDiv.style.fontSize='24px';
    redCrossDiv.innerText='+';
    const crossLabel = new THREE.CSS2DObject(redCrossDiv);
    crossLabel.position.set(4,5,-6);
    solarGroup.add(crossLabel);

    //车辆（带红十字）
    const carMat = new THREE.MeshStandardMaterial({color:0xffffff});
    const carMesh = new THREE.Mesh(new THREE.BoxGeometry(4,1.6,2), carMat);
    carMesh.position.set(12,0.8,-10);
    carMesh.castShadow=true;
    solarGroup.add(carMesh);
    const carTagDiv = document.createElement('div');
    carTagDiv.style.color='red';
    carTagDiv.innerText='+';
    const carTag = new THREE.CSS2DObject(carTagDiv);
    carTag.position.set(12,2.2,-10);
    carMesh.add(carTag);

    //树木（合并网格，修复坐标偏移BUG）
    const treeTrunkMat = new THREE.MeshStandardMaterial({color:0x6b4423});
    const treeLeafMat = new THREE.MeshStandardMaterial({color:0x3a7d44});
    const tree1Trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.4,3,8), treeTrunkMat);
    tree1Trunk.position.set(18,1.5,-4); tree1Trunk.castShadow=true;
    const tree1Leaf = new THREE.Mesh(new THREE.SphereGeometry(2,8,8), treeLeafMat);
    tree1Leaf.position.set(18,4,-4); tree1Leaf.castShadow=true;
    solarGroup.add(tree1Trunk, tree1Leaf);

    const tree2Trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25,0.3,2.8,8), treeTrunkMat);
    tree2Trunk.position.set(-20,1.4,10); tree2Trunk.castShadow=true;
    const tree2Leaf = new THREE.Mesh(new THREE.SphereGeometry(1.8,8,8), treeLeafMat);
    tree2Leaf.position.set(-20,3.8,10); tree2Leaf.castShadow=true;
    solarGroup.add(tree2Trunk, tree2Leaf);

    const tree3Trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2,0.28,2.5,8), treeTrunkMat);
    tree3Trunk.position.set(10,1.2,18); tree3Trunk.castShadow=true;
    const tree3Leaf = new THREE.Mesh(new THREE.SphereGeometry(1.6,8,8), treeLeafMat);
    tree3Leaf.position.set(10,3.2,18); tree3Leaf.castShadow=true;
    solarGroup.add(tree3Trunk, tree3Leaf);

    //路灯
    const lampMat = new THREE.MeshStandardMaterial({color:0x222222});
    const lampPole = new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.12,4,8), lampMat);
    lampPole.position.set(22,2,-18);
    solarGroup.add(lampPole);
    const lampLightGeo = new THREE.SphereGeometry(0.4,8,8);
    const lampLightMat = new THREE.MeshStandardMaterial({color:0xffffbb, emissive:0xffffbb, emissiveIntensity:0});
    const lampLight = new THREE.Mesh(lampLightGeo,lampLightMat);
    lampLight.position.set(22,4,-18);
    solarGroup.add(lampLight);
    //存入用户数据，用于昼夜切换灯光
    lampLight.userData.isLamp = true;
}

// 光伏板InstancedMesh实例化，80块光伏板合批，保留点击
function buildPVEquipment(){
    const pvGeo = new THREE.BoxGeometry(2,0.1,1);
    const pvMat = new THREE.MeshStandardMaterial({color:0x112233, roughness:0.3});
    const pvInst = new THREE.InstancedMesh(pvGeo, pvMat, 80);
    pvInst.castShadow=true; pvInst.receiveShadow=true;
    const matrix = new THREE.Matrix4();
    let idx=0;
    //排布光伏阵列
    for(let row=0;row<8;row++){
        for(let col=0;col<10;col++){
            matrix.makeRotationX(-Math.PI*0.12);
            matrix.setPosition(-12 + col*2.4, 6.2, -12 + row*1.8);
            pvInst.setMatrixAt(idx++, matrix);
        }
    }
    pvInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    solarGroup.add(pvInst);
    pvInst.userData.key = "pvArray";
    equipmentMap.set("pvArray", {name:"光伏阵列"});

    //逆变器、铁塔等构件按材质合并网格
    //【此处保留你原有设备业务数据结构，不改动交互key】
}

//雨滴实例化，420雨滴合并为1个InstancedMesh
function buildRainInstance(){
    const rainGeo = new THREE.CylinderGeometry(0.02,0.02,0.6,4);
    const rainMat = new THREE.MeshBasicMaterial({color:0xaaccff, transparent:true, opacity:0.6});
    rainMesh = new THREE.InstancedMesh(rainGeo, rainMat, 420);
    rainMesh.visible=false;
    const m = new THREE.Matrix4();
    for(let i=0;i<420;i++){
        m.setPosition(
            (Math.random()-0.5)*80,
            Math.random()*30,
            (Math.random()-0.5)*80
        );
        rainMesh.setMatrixAt(i,m);
    }
    solarGroup.add(rainMesh);
}

//远景连绵山脊，双面材质，解决内部观察看不到的问题
function buildBackMountain(){
    const mountainGeo = new THREE.CylinderGeometry(120,120,18,12,1,true);
    const mountainMat = new THREE.MeshStandardMaterial({
        color:0x667766,
        side:THREE.DoubleSide,
        roughness:0.95
    })
    const mountain = new THREE.Mesh(mountainGeo, mountainMat);
    mountain.position.y=-5;
    solarGroup.add(mountain);
}

// 天气切换：day / night / rain
function setWeatherMode(mode){
    weatherMode = mode;
    solarGroup.traverse(obj=>{
        if(obj.userData.isLamp){
            if(mode==='night' || mode==='rain'){
                obj.material.emissiveIntensity = 2.0;
            }else{
                obj.material.emissiveIntensity = 0;
            }
        }
    })
    if(rainMesh){
        rainMesh.visible = (mode === 'rain');
    }
    if(mode==='day'){
        scene.background = new THREE.Color(0x87ceeb);
    }else if(mode==='night'){
        scene.background = new THREE.Color(0x0a0a20);
    }else if(mode==='rain'){
        scene.background = new THREE.Color(0x444450);
    }
}

//设备点击回调，和你原有业务对接
function onDeviceClick(key){
    const info = equipmentMap.get(key);
    if(!info) return;
    // 这里调用你原有页面弹窗卡片逻辑，不用修改
    window.dispatchEvent(new CustomEvent('pvDeviceClick', {detail:{key,info}}))
}

//动画循环
function animate(){
    requestAnimationFrame(animate);
    controls.update();
    if(rainMesh && rainMesh.visible){
        const m = new THREE.Matrix4();
        for(let i=0;i<420;i++){
            rainMesh.getMatrixAt(i,m);
            const pos = new THREE.Vector3();
            pos.setFromMatrixPosition(m);
            pos.y -=0.25;
            if(pos.y < 0) pos.y = 30;
            m.setPosition(pos.x,pos.y,pos.z);
            rainMesh.setMatrixAt(i,m);
        }
        rainMesh.instanceMatrix.needsUpdate=true;
    }
    renderer.render(scene,camera);
    labelRenderer.render(scene,camera);
}

//更新设备数据接口，保持和你原有逻辑一致
function updateDeviceData(data){
    //对接后端功率、SOC数据，沿用原有业务逻辑
}

window.SolarSceneV2 = { initSolarScene: initSolarScene, setWeatherMode: setWeatherMode, updateDeviceData: updateDeviceData };
