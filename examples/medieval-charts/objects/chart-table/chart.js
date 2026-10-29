// Geometry of the portolan chart of the course, shared by the 3D chart table (object.js) and the
// figures of the workshop (generators/). Plain data and maths: no DOM, no three.js.
//
// The coasts are drawn from longitudes and latitudes (simplified by hand, about a point every half
// degree), projected with the scale of latitude 38° N (an equirectangular chart: close enough for
// the Mediterranean) and turned 9° anticlockwise, as on the medieval charts: they were compiled
// from compass bearings, and the compass then pointed about 9° east of true north. The sheet's own
// north (up) is therefore magnetic north, and so are the rhumb lines and the winds of the lab.
//
// Units: one unit of the chart is one degree of latitude (111.2 km). Distances are given in the
// "miles" of the charts, taken here as 1.25 km (historians put the portolan mile at 1.2–1.3 km).

export const ROTATION_DEG = 9;
export const ORIGIN = { lon: 15.4, lat: 38.5 };
const SCALE_LAT = 38;
const UNIT_KM = 111.2;
export const MILE_KM = 1.25;
export const MILES_PER_UNIT = UNIT_KM / MILE_KM;

// The sheet (a single calfskin): its rectangle in chart units, centred on the origin, and the neck
// of the skin on the west side, where the animal's neck was.
export const SHEET = { width: 45, height: 24.6, neck: 4.4 };

// The eight winds of the Mediterranean, clockwise from the sheet's north, with their colour on the
// chart (principal winds are ruled in black ink).
export const WINDS = [
  { id: 'tramontana', deg: 0 }, { id: 'greco', deg: 45 }, { id: 'levante', deg: 90 }, { id: 'scirocco', deg: 135 },
  { id: 'ostro', deg: 180 }, { id: 'libeccio', deg: 225 }, { id: 'ponente', deg: 270 }, { id: 'maestro', deg: 315 }
];

// ── Coasts (longitude, latitude) ─────────────────────────────────────
// One line from Brittany round Iberia, along the northern shore to the Black Sea and the Sea of
// Azov, back by Anatolia, the Levant and the African shore to the Atlantic coast of Morocco.
export const COAST = [
  [-4.6, 47.9], [-3.4, 47.7], [-2.6, 47.45], [-2.1, 47.1], [-1.9, 46.75], [-1.4, 46.35], [-1.15, 46.1], [-1.2, 45.65], [-1.15, 45.2], [-1.25, 44.6], [-1.35, 44.05], [-1.5, 43.55],
  [-1.8, 43.38], [-2.4, 43.33], [-2.9, 43.42], [-3.8, 43.47], [-4.6, 43.4], [-5.7, 43.56], [-6.5, 43.56], [-7.3, 43.72], [-8.0, 43.68], [-8.35, 43.4], [-8.95, 43.2], [-9.3, 42.9],
  [-9.0, 42.5], [-8.9, 42.1], [-8.85, 41.7], [-8.68, 41.15], [-8.85, 40.6], [-8.95, 40.15], [-9.35, 39.4], [-9.5, 38.78], [-9.2, 38.68], [-8.9, 38.5], [-8.8, 38.0], [-8.8, 37.5],
  [-8.98, 37.02], [-8.6, 37.1], [-7.9, 36.98], [-7.4, 37.17], [-6.9, 37.12], [-6.4, 36.8], [-6.3, 36.52], [-6.0, 36.2], [-5.6, 36.0], [-5.35, 36.15],
  [-4.9, 36.5], [-4.42, 36.72], [-3.5, 36.73], [-2.9, 36.75], [-2.46, 36.84], [-2.19, 36.72], [-1.9, 37.2], [-1.65, 37.4], [-0.98, 37.58], [-0.7, 37.65], [-0.75, 38.0],
  [-0.48, 38.35], [0.0, 38.65], [0.23, 38.73], [-0.1, 39.05], [-0.33, 39.45], [-0.05, 39.95], [0.5, 40.45], [0.88, 40.72], [1.25, 41.1], [2.17, 41.38], [2.8, 41.72],
  [3.2, 41.92], [3.3, 42.32], [3.05, 42.6], [3.1, 43.05], [3.7, 43.4], [4.2, 43.47], [4.8, 43.35], [5.37, 43.3], [5.9, 43.1], [6.6, 43.18], [7.0, 43.55], [7.27, 43.7],
  [7.7, 43.78], [8.2, 43.95], [8.93, 44.41], [9.5, 44.2], [9.85, 44.05], [10.3, 43.55], [10.5, 42.95], [11.1, 42.4], [11.8, 42.05], [12.25, 41.73], [12.9, 41.35], [13.6, 41.22],
  [14.0, 40.95], [14.25, 40.84], [14.33, 40.6], [14.75, 40.65], [15.0, 40.3], [15.3, 40.03], [15.65, 40.0], [15.8, 39.6], [16.0, 39.1], [16.2, 38.8], [15.9, 38.6], [15.64, 38.25],
  [15.68, 37.95], [16.06, 37.92], [16.5, 38.4], [17.15, 38.9], [17.1, 39.4], [16.6, 39.75], [16.95, 40.25], [17.24, 40.47], [17.75, 40.3], [17.99, 40.06], [18.36, 39.8],
  [18.49, 40.15], [17.95, 40.64], [16.87, 41.13], [16.28, 41.32], [15.92, 41.6], [16.18, 41.9], [15.75, 41.92], [15.0, 42.0], [14.22, 42.47], [13.8, 42.95], [13.51, 43.62],
  [12.57, 44.06], [12.28, 44.42], [12.5, 44.95], [12.28, 45.22], [12.33, 45.44], [12.6, 45.55], [13.1, 45.75], [13.77, 45.65], [13.55, 45.45], [13.6, 45.2], [13.85, 44.87],
  [14.2, 45.1], [14.44, 45.33], [14.9, 45.05], [15.23, 44.12], [15.9, 43.73], [16.44, 43.51], [17.0, 43.3], [17.5, 43.0], [18.09, 42.65], [18.55, 42.42], [19.1, 42.1],
  [19.4, 41.85], [19.45, 41.3], [19.4, 40.85], [19.47, 40.45], [19.9, 40.0], [20.05, 39.8], [20.27, 39.5], [20.75, 38.95], [21.1, 38.4], [21.73, 38.25], [21.1, 37.93],
  [21.55, 37.4], [21.67, 36.92], [21.7, 36.82], [21.96, 36.8], [22.1, 37.03], [22.48, 36.38], [22.56, 36.76], [23.2, 36.43], [23.06, 36.69], [22.8, 37.57], [23.15, 37.63],
  [22.98, 37.93], [23.64, 37.94], [24.03, 37.65], [24.0, 38.05], [23.6, 38.46], [23.2, 38.75], [22.95, 39.36], [22.6, 40.0], [22.94, 40.64], [23.4, 39.95], [23.6, 40.25],
  [23.9, 40.0], [24.0, 40.3], [24.4, 40.15], [23.9, 40.72], [24.4, 40.94], [25.2, 40.95], [25.87, 40.85], [26.07, 40.72], [26.4, 40.6], [26.2, 40.05], [26.67, 40.41],
  [27.5, 40.97], [28.25, 41.07], [28.98, 41.01], [29.1, 41.23], [28.6, 41.45], [28.1, 41.63], [27.75, 42.0], [27.47, 42.5], [27.92, 43.2], [28.6, 43.8], [28.65, 44.17],
  [29.0, 44.75], [29.7, 45.2], [30.2, 45.85], [30.73, 46.48], [31.6, 46.62], [32.0, 46.45], [32.6, 46.1], [33.7, 46.15], [33.4, 45.6], [32.5, 45.38], [33.4, 45.2], [33.5, 44.6],
  [34.0, 44.42], [34.5, 44.7], [35.2, 44.82], [35.4, 45.03], [36.0, 45.05], [36.47, 45.36], [35.9, 45.47], [35.1, 45.6], [35.0, 46.2], [36.0, 46.5], [36.8, 46.75], [37.55, 47.08],
  [38.4, 47.15], [38.9, 47.22], [39.3, 47.1], [38.3, 46.62], [38.0, 46.05], [37.6, 45.6], [37.4, 45.32], [36.7, 45.2], [37.3, 44.9], [37.8, 44.7], [38.6, 44.3], [39.7, 43.6],
  [41.0, 43.0], [41.67, 42.15], [41.6, 41.6], [41.0, 41.15], [39.72, 41.0], [38.4, 40.9], [37.5, 41.1], [36.33, 41.29], [35.6, 41.65], [35.15, 42.02], [34.0, 41.98], [33.0, 41.9],
  [32.4, 41.75], [31.4, 41.28], [30.5, 41.15], [29.6, 41.18], [29.08, 41.1], [29.02, 41.0], [29.5, 40.8], [29.1, 40.43], [27.97, 40.35], [26.68, 40.35], [26.4, 40.12],
  [26.2, 39.95], [26.1, 39.5], [26.69, 39.32], [26.85, 38.95], [26.75, 38.67], [26.4, 38.62], [26.3, 38.32], [26.75, 38.2], [27.26, 37.86], [27.27, 37.37], [27.43, 37.03],
  [27.4, 36.7], [28.27, 36.82], [29.1, 36.62], [29.64, 36.2], [30.15, 36.3], [30.5, 36.5], [30.7, 36.88], [31.5, 36.75], [32.0, 36.54], [32.83, 36.02], [33.5, 36.15], [33.93, 36.38],
  [34.64, 36.8], [35.3, 36.6], [35.78, 36.77], [36.17, 36.59], [35.95, 36.1], [35.78, 35.52], [35.88, 34.89], [35.83, 34.44], [35.5, 33.9], [35.37, 33.56], [35.2, 33.27],
  [35.07, 32.93], [34.96, 32.83], [34.75, 32.05], [34.45, 31.52], [34.2, 31.3], [33.8, 31.13], [32.9, 31.15], [32.3, 31.27], [31.8, 31.52], [31.0, 31.55], [30.4, 31.47],
  [29.92, 31.2], [29.0, 30.9], [28.2, 31.05], [27.25, 31.35], [26.0, 31.55], [25.15, 31.57], [23.97, 32.08], [23.0, 32.6], [22.64, 32.77], [21.97, 32.9], [21.0, 32.75],
  [20.07, 32.12], [19.9, 31.4], [20.1, 30.75], [19.58, 30.4], [18.53, 30.5], [17.6, 30.9], [16.59, 31.21], [15.6, 31.8], [15.1, 32.38], [14.26, 32.65], [13.19, 32.89],
  [12.08, 32.93], [11.1, 33.5], [10.5, 33.65], [10.1, 33.88], [10.4, 34.3], [10.76, 34.74], [11.06, 35.5], [10.83, 35.77], [10.64, 35.83], [10.55, 36.4], [11.05, 37.08],
  [10.7, 36.85], [10.3, 36.8], [10.25, 37.05], [9.87, 37.27], [9.2, 37.18], [8.75, 36.96], [8.2, 36.95], [7.77, 36.9], [7.2, 37.05], [6.9, 36.88], [6.56, 37.0], [5.77, 36.82],
  [5.08, 36.75], [4.5, 36.88], [3.91, 36.92], [3.06, 36.77], [2.45, 36.6], [2.19, 36.61], [1.31, 36.51], [0.6, 36.15], [0.09, 35.93], [-0.3, 35.85], [-0.64, 35.7],
  [-1.2, 35.4], [-1.65, 35.17], [-2.3, 35.12], [-2.94, 35.29], [-2.97, 35.44], [-3.4, 35.2], [-3.93, 35.25], [-4.6, 35.2], [-5.25, 35.55], [-5.31, 35.89], [-5.8, 35.78],
  [-5.92, 35.79], [-6.15, 35.19], [-6.6, 34.26], [-6.84, 34.02], [-7.6, 33.6], [-8.5, 33.25], [-9.0, 32.75], [-9.24, 32.3], [-9.77, 31.51], [-9.88, 30.63], [-9.6, 30.42],
  [-9.75, 29.95], [-10.0, 29.5]
];

// Islands, with the colours medieval chart-makers gave them (gold, red, green, blue) or none.
export const ISLANDS = [
  { id: 'majorca', fill: 'gold', points: [[2.35, 39.58], [2.6, 39.75], [2.95, 39.92], [3.2, 39.96], [3.12, 39.82], [3.47, 39.72], [3.3, 39.45], [3.07, 39.27], [2.78, 39.37], [2.68, 39.55], [2.5, 39.5]] },
  { id: 'minorca', fill: 'red', points: [[3.82, 40.05], [4.0, 40.08], [4.3, 39.95], [4.25, 39.83], [3.95, 39.92], [3.8, 39.98]] },
  { id: 'ibiza', fill: 'green', points: [[1.2, 38.97], [1.45, 39.1], [1.6, 39.05], [1.55, 38.88], [1.35, 38.85]] },
  { id: 'corsica', fill: null, points: [[9.4, 43.0], [9.47, 42.7], [9.53, 42.3], [9.4, 41.9], [9.25, 41.38], [9.08, 41.45], [8.8, 41.6], [8.6, 41.9], [8.65, 42.15], [8.55, 42.35], [8.7, 42.6], [9.1, 42.73], [9.35, 43.0]] },
  { id: 'sardinia', fill: null, points: [[9.2, 41.25], [9.55, 41.1], [9.7, 40.9], [9.8, 40.5], [9.65, 40.1], [9.65, 39.6], [9.55, 39.15], [9.1, 39.2], [8.85, 38.9], [8.4, 39.05], [8.4, 39.4], [8.45, 39.9], [8.4, 40.4], [8.2, 40.55], [8.2, 40.9], [8.6, 40.95], [8.95, 41.2]] },
  { id: 'sicily', fill: null, points: [[12.43, 37.8], [12.5, 38.05], [12.85, 38.05], [13.35, 38.2], [13.9, 38.0], [14.5, 38.05], [15.1, 38.15], [15.55, 38.27], [15.25, 37.8], [15.1, 37.3], [15.3, 37.0], [15.1, 36.68], [14.4, 36.78], [13.9, 37.08], [13.2, 37.4], [12.6, 37.6]] },
  { id: 'elba', fill: 'red', points: [[10.1, 42.82], [10.45, 42.86], [10.42, 42.72], [10.2, 42.73]] },
  { id: 'malta', fill: 'red', points: [[14.33, 35.98], [14.57, 35.88], [14.45, 35.8], [14.32, 35.88]] },
  { id: 'djerba', fill: 'gold', points: [[10.75, 33.88], [11.05, 33.86], [11.0, 33.68], [10.78, 33.7]] },
  { id: 'corfu', fill: 'green', points: [[19.65, 39.8], [19.95, 39.77], [19.95, 39.45], [19.85, 39.4], [19.72, 39.6]] },
  { id: 'cephalonia', fill: null, points: [[20.4, 38.42], [20.65, 38.32], [20.62, 38.1], [20.38, 38.18]] },
  { id: 'zante', fill: 'gold', points: [[20.7, 37.88], [20.95, 37.8], [20.88, 37.66], [20.66, 37.75]] },
  { id: 'euboea', fill: null, points: [[22.85, 38.85], [23.3, 38.95], [23.6, 38.75], [24.1, 38.65], [24.6, 38.15], [24.55, 37.98], [24.1, 38.2], [23.6, 38.45], [23.2, 38.75]] },
  { id: 'crete', fill: null, points: [[23.55, 35.6], [23.7, 35.27], [24.4, 35.2], [25.0, 35.0], [25.7, 35.0], [26.3, 35.05], [26.3, 35.3], [25.8, 35.15], [25.15, 35.35], [24.3, 35.35], [23.85, 35.55]] },
  { id: 'rhodes', fill: 'red', points: [[27.75, 36.25], [28.0, 36.4], [28.22, 36.45], [28.25, 36.3], [28.0, 35.9], [27.75, 36.1]] },
  { id: 'cyprus', fill: null, points: [[32.3, 34.95], [32.4, 35.05], [32.95, 35.4], [33.6, 35.35], [34.6, 35.68], [34.0, 35.1], [33.9, 34.95], [33.1, 34.6], [32.4, 34.75]] },
  { id: 'chios', fill: 'blue', points: [[25.85, 38.6], [26.15, 38.55], [26.1, 38.25], [25.95, 38.2], [25.88, 38.4]] },
  { id: 'lesbos', fill: null, points: [[25.85, 39.25], [26.2, 39.38], [26.6, 39.05], [26.3, 38.98], [25.95, 39.1]] },
  { id: 'naxos', fill: 'gold', points: [[25.35, 37.15], [25.55, 37.1], [25.5, 36.95], [25.35, 36.98]] },
  { id: 'andros', fill: 'green', points: [[24.68, 37.98], [24.98, 37.88], [24.9, 37.78], [24.68, 37.86]] },
  { id: 'milos', fill: 'blue', points: [[24.35, 36.76], [24.55, 36.74], [24.5, 36.65], [24.35, 36.68]] },
  { id: 'samos', fill: 'red', points: [[26.6, 37.8], [26.95, 37.75], [26.9, 37.65], [26.6, 37.68]] },
  { id: 'kos', fill: 'green', points: [[26.95, 36.9], [27.35, 36.9], [27.3, 36.75], [26.98, 36.8]] }
];

// Ports named on the chart: medieval spellings (the words are object strings, keyed port.<id>),
// red for the great harbours. inland: the bearing (true, clockwise from north) along which the
// name is written, from the coast into the land, perpendicular to the coast as on the charts.
export const PORTS = [
  { id: 'lisbon', lon: -9.15, lat: 38.7, inland: 80, major: true },
  { id: 'seville', lon: -6.2, lat: 36.75, inland: 40, major: false },
  { id: 'ceuta', lon: -5.31, lat: 35.89, inland: 190, major: false },
  { id: 'almeria', lon: -2.46, lat: 36.84, inland: 345, major: false },
  { id: 'cartagena', lon: -0.98, lat: 37.6, inland: 300, major: false },
  { id: 'valencia', lon: -0.33, lat: 39.45, inland: 280, major: false },
  { id: 'barcelona', lon: 2.17, lat: 41.38, inland: 320, major: true },
  { id: 'marseille', lon: 5.37, lat: 43.3, inland: 0, major: true },
  { id: 'genoa', lon: 8.93, lat: 44.41, inland: 15, major: true },
  { id: 'pisa', lon: 10.3, lat: 43.6, inland: 70, major: false },
  { id: 'naples', lon: 14.25, lat: 40.84, inland: 40, major: true },
  { id: 'messina', lon: 15.55, lat: 38.19, inland: 300, major: false },
  { id: 'palermo', lon: 13.36, lat: 38.12, inland: 175, major: false },
  { id: 'cagliari', lon: 9.11, lat: 39.21, inland: 0, major: false },
  { id: 'palma', lon: 2.65, lat: 39.56, inland: 25, major: true },
  { id: 'venice', lon: 12.33, lat: 45.44, inland: 330, major: true },
  { id: 'ancona', lon: 13.51, lat: 43.62, inland: 220, major: false },
  { id: 'ragusa', lon: 18.09, lat: 42.65, inland: 45, major: false },
  { id: 'otranto', lon: 18.49, lat: 40.15, inland: 260, major: false },
  { id: 'modon', lon: 21.7, lat: 36.82, inland: 60, major: false },
  { id: 'candia', lon: 25.14, lat: 35.34, inland: 175, major: true },
  { id: 'constantinople', lon: 28.98, lat: 41.01, inland: 330, major: true },
  { id: 'caffa', lon: 35.4, lat: 45.03, inland: 340, major: true },
  { id: 'tana', lon: 39.35, lat: 47.12, inland: 110, major: false },
  { id: 'trebizond', lon: 39.72, lat: 41.0, inland: 170, major: false },
  { id: 'laiazzo', lon: 35.78, lat: 36.77, inland: 15, major: false },
  { id: 'famagusta', lon: 33.94, lat: 35.12, inland: 270, major: true },
  { id: 'acre', lon: 35.07, lat: 32.93, inland: 90, major: true },
  { id: 'alexandria', lon: 29.92, lat: 31.2, inland: 180, major: true },
  { id: 'tripoli', lon: 13.19, lat: 32.89, inland: 185, major: false },
  { id: 'tunis', lon: 10.18, lat: 36.8, inland: 230, major: true },
  { id: 'bugia', lon: 5.08, lat: 36.75, inland: 190, major: false },
  { id: 'algiers', lon: 3.06, lat: 36.77, inland: 185, major: false },
  { id: 'oran', lon: -0.64, lat: 35.7, inland: 200, major: false }
];

// The three voyages of the chart table: from, to, and what the chart says (computed below).
export const VOYAGE_PORTS = [['palma', 'cagliari'], ['genoa', 'barcelona'], ['palermo', 'naples']];

// ── Projection ────────────────────────────────────────────────────────
const DEG = Math.PI / 180;
const COS_SCALE = Math.cos(SCALE_LAT * DEG);
const ROT = ROTATION_DEG * DEG;

// Longitude and latitude to the sheet: x east, y north (the sheet's north), in units.
export function project(lon, lat) {
  const x = (lon - ORIGIN.lon) * COS_SCALE;
  const y = lat - ORIGIN.lat;
  return [x * Math.cos(ROT) - y * Math.sin(ROT), x * Math.sin(ROT) + y * Math.cos(ROT)];
}

export const port = (id) => {
  const found = PORTS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no port ${id}`);
  const [x, y] = project(found.lon, found.lat);
  // The inland bearing is true: on the sheet it turns with the chart.
  return { ...found, x, y, inlandSheet: found.inland - ROTATION_DEG };
};

// Bearing on the sheet (clockwise from the sheet's north, degrees 0–360) and distance in miles.
export function bearing(a, b) { return (Math.atan2(b.x - a.x, b.y - a.y) / DEG + 360) % 360; }
export function miles(a, b) { return Math.hypot(b.x - a.x, b.y - a.y) * MILES_PER_UNIT; }
export function nearestWind(deg) {
  let best = WINDS[0];
  for (const wind of WINDS) if (angleGap(wind.deg, deg) < angleGap(best.deg, deg)) best = wind;
  return best;
}
export function angleGap(a, b) { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; }

export const VOYAGES = VOYAGE_PORTS.map(([from, to]) => {
  const a = port(from), b = port(to);
  const course = bearing(a, b);
  return { from, to, course, wind: nearestWind(course).id, miles: miles(a, b) };
});

// ── Rhumb network ─────────────────────────────────────────────────────
// The hidden circle: sixteen points on its rim and its centre, each the centre of a 32-point wind
// rose whose lines run across the sheet. Principal winds in black, half-winds in green,
// quarter-winds in red.
export const HIDDEN_CIRCLE = { x: 0, y: -0.1, r: 11.6 };

export function roseCentres() {
  const { x, y, r } = HIDDEN_CIRCLE;
  const out = [{ x, y, rim: false }];
  for (let k = 0; k < 16; k++) {
    const a = k * 22.5 * DEG;
    out.push({ x: x + r * Math.sin(a), y: y + r * Math.cos(a), rim: true, k });
  }
  return out;
}

export function rhumbKind(direction) {
  const step = Math.round(direction / 11.25) % 32;
  return step % 4 === 0 ? 'wind' : step % 2 === 0 ? 'half' : 'quarter';
}

// Every rhumb line as a segment from its rose centre to the edge of the sheet (rectangle without
// the neck). Each line of the network is drawn once from each of its two ends' roses on the
// charts; here each rose sends 32 rays, which overlap where roses align, as on the charts.
export function rhumbs(extent = SHEET) {
  const halfW = extent.width / 2, halfH = extent.height / 2;
  const out = [];
  for (const centre of roseCentres()) {
    for (let step = 0; step < 32; step++) {
      const direction = step * 11.25;
      const dx = Math.sin(direction * DEG), dy = Math.cos(direction * DEG);
      // Distance to the edge of the rectangle along (dx, dy).
      const tx = dx > 1e-9 ? (halfW - centre.x) / dx : dx < -1e-9 ? (-halfW - centre.x) / dx : Infinity;
      const ty = dy > 1e-9 ? (halfH - centre.y) / dy : dy < -1e-9 ? (-halfH - centre.y) / dy : Infinity;
      const t = Math.min(tx, ty);
      out.push({ x1: centre.x, y1: centre.y, x2: centre.x + dx * t, y2: centre.y + dy * t, direction, kind: rhumbKind(direction), rim: centre.rim });
    }
  }
  return out;
}

// The rhumb lines' ink, one setting for every picture of the chart (the 3D table's skin, the whole
// chart and the workshop's stages): faint, each kind in its colour (tokens color.rhumb-*), so that the
// coasts and the names read first. A picture rules its lines at its own width (in chart units) and the
// ink is spread over that width: a line twice as wide is half as opaque, and looks the same from the
// reader's distance.
export const RHUMB_INK = { wind: 0.01123, half: 0.00625, quarter: 0.00508 };
export function rhumbOpacity(kind, width) {
  return Math.min(1, RHUMB_INK[kind] / width);
}

// ── Hand-drawn coasts ─────────────────────────────────────────────────
// Medieval coasts are drawn as chains of small curves (bays and capes larger than life, the
// harbours a sailor needs). A coast is densified and its points nudged sideways by seeded noise,
// with a scallop at every step.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function inkLine(lonLat, { seed = 7, step = 0.16, amplitude = 0.05, closed = false } = {}) {
  const points = lonLat.map(([lon, lat]) => project(lon, lat));
  if (closed) points.push(points[0]);
  const random = rng(seed);
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[i + 1];
    const length = Math.hypot(x1 - x0, y1 - y0);
    const count = Math.max(1, Math.round(length / step));
    const nx = -(y1 - y0) / (length || 1), ny = (x1 - x0) / (length || 1);
    for (let j = 0; j < count; j++) {
      const t = j / count;
      // Scallops: small arcs between the points, and a slow wander.
      const scallop = Math.sin(t * count * Math.PI) * amplitude * 0.5;
      const wander = (random() - 0.5) * amplitude;
      out.push([x0 + (x1 - x0) * t + nx * (scallop + wander), y0 + (y1 - y0) * t + ny * (scallop + wander)]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

// Points of an island, projected (closed).
export function islandOutline(island) { return inkLine(island.points, { seed: island.id.length * 31 + island.points.length, step: 0.1, amplitude: 0.035, closed: true }); }

// The outline of the skin: the rectangle with the neck on the west side, in units.
export function sheetOutline(extent = SHEET) {
  const w = extent.width / 2, h = extent.height / 2, n = extent.neck;
  const out = [];
  // East edge and the corners, slightly irregular like a trimmed skin.
  out.push([-w, h], [w * 0.98, h * 1.0], [w, h * 0.96], [w * 1.0, -h * 0.97], [w * 0.97, -h], [-w, -h]);
  // The neck: a rounded tongue to the west.
  const steps = 18;
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * Math.PI;
    out.push([-w - n * Math.cos(a) * (0.9 + 0.1 * Math.cos(a * 3)), h * 0.62 * Math.sin(a)]);
  }
  return out;
}

// Scale bar: in the south-west of the sheet (inland Africa, left blank on the charts), 300 miles
// in six divisions of 50.
export const SCALE_BAR = { x: -13.2, y: -10.4, miles: 300, divisions: 6 };
