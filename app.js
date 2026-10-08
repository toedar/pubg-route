'use strict';

// 맵 크기(m)는 PUBG 공식 API 기준 (cm / 100). 이미지 전체가 이 크기에 대응한다.
const MAPS = [
  { id: 'Erangel', name: '에란겔', size: 8160 },
  { id: 'Miramar', name: '미라마', size: 8160 },
  { id: 'Taego',   name: '테이고', size: 8160 },
  { id: 'Vikendi', name: '비켄디', size: 8160 },
  { id: 'Rondo',   name: '론도',   size: 8160 },
  { id: 'Sanhok',  name: '사녹',   size: 4080 },
  { id: 'Karakin', name: '카라킨', size: 2040 },
  { id: 'Paramo',  name: '파라모', size: 3060 },
  { id: 'Deston',  name: '데스턴', size: 8160 },
  { id: 'Haven',   name: '헤이븐', size: 1020 },
];

const IMG_PX = 4096;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const $ = (id) => document.getElementById(id);

const map = L.map('map', {
  crs: L.CRS.Simple,
  zoomControl: false,
  attributionControl: false,
  zoomSnap: 0,
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 120,
  bounceAtZoomLimits: false,
  maxBoundsViscosity: 0.8,
  doubleClickZoom: false,
  renderer: L.canvas({ padding: 0.5 }),
});

let cur = null;
let lowLayer = null, hiLayer = null;
let gridLayer = L.layerGroup().addTo(map);
let routeLayer = L.layerGroup().addTo(map);
let points = [];      // L.LatLng[] (lat = 북쪽 방향 m, lng = 동쪽 방향 m)
let markers = [];
let gridOn = store.get('grid') !== '0';

/* ---------- 맵 탭 ---------- */
const tabs = $('maps');
MAPS.forEach((m) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = m.name;
  b.dataset.id = m.id;
  b.onclick = () => loadMap(m.id);
  tabs.appendChild(b);
});

function loadMap(id) {
  const m = MAPS.find((x) => x.id === id) || MAPS[0];
  cur = m;
  store.set('map', m.id);
  [...tabs.children].forEach((b) => b.classList.toggle('on', b.dataset.id === m.id));
  tabs.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });

  if (lowLayer) map.removeLayer(lowLayer);
  if (hiLayer) map.removeLayer(hiLayer);

  const S = m.size;
  const bounds = [[0, 0], [S, S]];
  lowLayer = L.imageOverlay(`maps/${m.id}_s.jpg`, bounds, { interactive: false }).addTo(map);
  hiLayer = L.imageOverlay(`maps/${m.id}.jpg`, bounds, { interactive: false, className: 'hi' }).addTo(map);
  $('loading').hidden = false;
  const loadedFor = m.id;
  hiLayer.once('load', () => {
    if (cur.id !== loadedFor) return;
    $('loading').hidden = true;
    lowLayer && map.removeLayer(lowLayer);
  });
  hiLayer.once('error', () => { $('loading').textContent = '지도 불러오기 실패'; });

  // 4096px 이미지를 2배 확대까지 허용
  const maxZoom = Math.log2(IMG_PX / S) + 1;
  map.setMaxZoom(maxZoom);
  const pad = S * 0.15;
  map.setMaxBounds([[-pad, -pad], [S + pad, S + pad]]);
  map.setMinZoom(-20);
  map.fitBounds(bounds, { animate: false, paddingTopLeft: [0, 50], paddingBottomRight: [0, $('panel').offsetHeight + 10] });
  map.setMinZoom(map.getZoom() - 0.5);

  clearRoute();
  drawGrid();
}

/* ---------- 격자 ---------- */
function drawGrid() {
  gridLayer.clearLayers();
  if (!gridOn || !cur) return;
  const S = cur.size;
  const major = S >= 2000 ? 1000 : 100;
  // 100m 칸이 화면에서 25px 이상일 때만 보조선 표시 (2^zoom = px/m)
  const showMinor = major > 100 && Math.pow(2, map.getZoom()) * 100 >= 25;
  const majorStyle = { color: '#fff', weight: 1.2, opacity: 0.55, interactive: false };
  const minorStyle = { color: '#fff', weight: 0.6, opacity: 0.22, interactive: false };

  // 격자는 지도 왼쪽 위 모서리 기준
  for (let v = 0; v <= S; v += 100) {
    const isMajor = v % major === 0;
    if (!isMajor && !showMinor) continue;
    const style = isMajor ? majorStyle : minorStyle;
    L.polyline([[0, v], [S, v]], style).addTo(gridLayer);
    L.polyline([[S - v, 0], [S - v, S]], style).addTo(gridLayer);
  }
}
map.on('zoomend', () => gridOn && drawGrid());

/* ---------- 경로 ---------- */
// 옷핀 모양: 뾰족한 끝(왼쪽 위)이 찍은 위치, 머리(오른쪽 아래)를 잡고 옮긴다
const PIN_SIZE = 68;
const PIN_TIP = 3;
function makeIcon(label, cls) {
  return L.divIcon({
    className: 'pin ' + cls,
    html: `<svg width="${PIN_SIZE}" height="${PIN_SIZE}" viewBox="0 0 ${PIN_SIZE} ${PIN_SIZE}">
      <polygon class="needle" points="3,3 40.5,35.5 35.5,40.5" />
      <circle class="hit" cx="46" cy="46" r="21" />
      <circle class="head" cx="46" cy="46" r="14" />
      <text x="46" y="46">${label}</text>
    </svg>`,
    iconSize: [PIN_SIZE, PIN_SIZE],
    iconAnchor: [PIN_TIP, PIN_TIP],
  });
}

map.on('click', (e) => {
  if (!cur) return;
  const ll = clampLL(e.latlng);
  if (points.length >= 2) clearRoute();
  points.push(ll);
  if (navigator.vibrate) navigator.vibrate(10);
  renderRoute();
});

function clampLL(ll) {
  const S = cur.size;
  return L.latLng(Math.min(S, Math.max(0, ll.lat)), Math.min(S, Math.max(0, ll.lng)));
}

function renderRoute() {
  routeLayer.clearLayers();
  markers = [];

  if (points.length >= 2) {
    L.polyline(points, { color: '#000', weight: 7, opacity: 0.45, interactive: false }).addTo(routeLayer);
    L.polyline(points, { color: '#ffd400', weight: 3.5, opacity: 1, dashArray: '10 7', interactive: false }).addTo(routeLayer);

  }

  points.forEach((p, i) => {
    const label = i === 0 ? 'A' : 'B';
    const cls = i === 0 ? 'start' : 'end';
    const mk = L.marker(p, { icon: makeIcon(label, cls), draggable: true, autoPan: true }).addTo(routeLayer);
    mk.on('drag', (ev) => {
      points[i] = clampLL(ev.target.getLatLng());
      updateStats();
      redrawLines();
    });
    mk.on('dragend', () => renderRoute());
    markers.push(mk);
  });

  updateStats();
}

// 드래그 중엔 선만 빠르게 갱신
function redrawLines() {
  routeLayer.eachLayer((l) => { if (l instanceof L.Polyline) l.setLatLngs(points); });
}

function dist(a, b) {
  return Math.hypot(a.lat - b.lat, a.lng - b.lng);
}


function updateStats() {
  const hint = $('hint'), stats = $('stats');
  if (points.length < 2) {
    stats.hidden = true;
    hint.hidden = false;
    hint.textContent = points.length === 0 ? '출발지를 탭하세요' : '도착지를 탭하세요';
    return;
  }
  hint.hidden = true;
  stats.hidden = false;

  const d = dist(points[0], points[1]);
  $('dist').textContent = d >= 1000 ? (d / 1000).toFixed(2) : Math.round(d);
  $('dist').nextElementSibling.textContent = d >= 1000 ? 'km' : 'm';
}

function clearRoute() {
  points = [];
  routeLayer.clearLayers();
  markers = [];
  updateStats();
}

/* ---------- 버튼 ---------- */
$('btnClear').onclick = clearRoute;
$('btnUndo').onclick = () => { points.pop(); renderRoute(); };
$('btnGrid').onclick = (e) => {
  gridOn = !gridOn;
  store.set('grid', gridOn ? '1' : '0');
  e.currentTarget.classList.toggle('on', gridOn);
  drawGrid();
};
$('btnGrid').classList.toggle('on', gridOn);

window.addEventListener('resize', () => map.invalidateSize());

loadMap(store.get('map') || 'Erangel');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
