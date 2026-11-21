// Orthophoto as a base map of the GCP map: a task of the WebODM that hosts the plugin, or a local GeoTIFF.
//
// WebODM task. The plugin page is served by WebODM itself (/plugins/gcp-editor-pro/...), so the API is on
// the same origin and the session cookie of the logged-in user authenticates the JSON calls and the tile
// images. Outside WebODM (ng serve, standalone build) the task list fails and only the local file is offered.
//   GET /api/projects/                                            -> [{id, name, ...}]
//   GET /api/projects/<p>/tasks/                                  -> [{id, name, available_assets, ...}]
//   GET /api/projects/<p>/tasks/<t>/orthophoto/tiles.json         -> {tiles: [url], minzoom, maxzoom, bounds}
//   GET /api/projects/<p>/tasks/<t>/orthophoto/tiles/{z}/{x}/{y}  (XYZ scheme, 256 px)
//
// Local GeoTIFF. Read in the browser with geotiff.js (already shipped in geotiff/geotiff.js for the image
// tagger). Nothing is uploaded and the file is not loaded whole: each map tile reads only the window it
// needs, from the overview that fits the zoom, and is reprojected to the map pixel by pixel.
import * as L from 'leaflet';
import proj4 from 'proj4';

export interface OrthoTask {
    projectId: number;
    projectName: string;
    id: string;
    name: string;
    label?: string;
}

export interface OrthoSource {
    name: string;
    layer: L.Layer;
    bounds: L.LatLngBounds;
}

const TILE = 256;
// Largest window (in pixels of the file) a single map tile may read. Only reached by a
// GeoTIFF without overviews seen from far away; that tile is left empty instead of freezing the page.
const MAX_WINDOW_PIXELS = 2048 * 2048;

function getJson(url: string): Promise<any> {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(r => {
            if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
            return r.json();
        });
}

// The API answers with a plain array, or with {results: [...]} when it paginates
function asList(data: any): any[] {
    if (Array.isArray(data)) return data;
    return data && Array.isArray(data.results) ? data.results : [];
}

/** Tasks with an orthophoto, of every project the logged-in user can see (newest first). */
export async function listOrthoTasks(): Promise<OrthoTask[]> {
    const projects = asList(await getJson('/api/projects/?ordering=-created_at'));
    const perProject = await Promise.all(projects.map(async p => {
        try {
            const tasks = asList(await getJson(`/api/projects/${p.id}/tasks/?ordering=-created_at`));
            return tasks
                .filter(t => Array.isArray(t.available_assets) && t.available_assets.indexOf('orthophoto.tif') !== -1)
                .map(t => ({ projectId: p.id, projectName: p.name, id: t.id, name: t.name || t.id }));
        } catch (e) {
            return [];
        }
    }));
    const tasks: OrthoTask[] = [].concat(...perProject);
    const severalProjects = tasks.some(t => t.projectId !== tasks[0].projectId);
    tasks.forEach(t => t.label = severalProjects ? `${t.projectName} / ${t.name}` : t.name);
    return tasks;
}

export async function taskOrthoSource(task: OrthoTask): Promise<OrthoSource> {
    const info = await getJson(`/api/projects/${task.projectId}/tasks/${task.id}/orthophoto/tiles.json`);
    const [w, s, e, n] = info.bounds;
    const bounds = L.latLngBounds(L.latLng(s, w), L.latLng(n, e));
    const name = info.name || task.name;

    const layer = L.tileLayer(info.tiles[0], {
        attribution: 'Orthophoto: ' + escapeHtml(name),
        bounds,
        minZoom: 0,
        minNativeZoom: info.minzoom,
        // Deepest level the server renders (finer than the pixel of the orthophoto);
        // past it Leaflet stretches the tiles, like the other base maps
        maxNativeZoom: info.maxzoom,
        maxZoom: 99
    });
    return { name, layer, bounds };
}

function escapeHtml(text: string): string {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let geotiffLib: Promise<any> = null;
function loadGeoTiffLib(): Promise<any> {
    if ((window as any).GeoTIFF) return Promise.resolve((window as any).GeoTIFF);
    if (geotiffLib === null) {
        geotiffLib = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'geotiff/geotiff.js';
            script.onload = () => resolve((window as any).GeoTIFF);
            script.onerror = () => { geotiffLib = null; reject(new Error('Cannot load the GeoTIFF reader')); };
            document.head.appendChild(script);
        });
    }
    return geotiffLib;
}

/**
 * @param epsgToProj4 returns the proj4 definition of an EPSG code, or null if unknown
 */
export async function geoTiffOrthoSource(file: File, epsgToProj4: (code: number) => string): Promise<OrthoSource> {
    const GeoTIFF = await loadGeoTiffLib();
    const tiff = await GeoTIFF.fromBlob(file);
    const first = await tiff.getImage(0);

    // Coordinate reference system
    let keys: any = null;
    try { keys = first.getGeoKeys(); } catch (e) { /* not georeferenced */ }
    const epsg = keys ? (keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey) : null;
    if (!epsg || epsg === 32767) throw new Error('This TIFF has no EPSG coordinate reference system (is it a GeoTIFF?).');
    const def = epsgToProj4(epsg);
    if (!def) throw new Error(`Unknown coordinate reference system EPSG:${epsg}.`);
    const toSrc = proj4('EPSG:4326', def);

    // Pixel format
    const fd = first.fileDirectory;
    const bits: number[] = Array.from(fd.BitsPerSample || [8]);
    if (bits.some(b => b !== 8)) throw new Error('Only 8-bit orthophotos are supported.');
    const spp: number = first.getSamplesPerPixel();
    const palette = fd.PhotometricInterpretation === 3;
    if (palette || fd.PhotometricInterpretation === 5 || fd.PhotometricInterpretation === 6) {
        throw new Error('This TIFF color format is not supported (use RGB or grayscale).');
    }
    const colorBands = spp >= 3 ? 3 : 1;
    const alphaBand = spp === 2 ? 1 : (spp >= 4 ? 3 : -1);
    const noData: number = first.getGDALNoData();

    // Georeference: origin at the top-left corner, resolution per pixel (resY negative)
    const [oX, oY] = first.getOrigin();
    const [rX, rY] = first.getResolution();
    const fullW: number = first.getWidth(), fullH: number = first.getHeight();
    if (!isFinite(oX) || !isFinite(rX) || rX === 0 || rY === 0) throw new Error('This TIFF is not georeferenced.');

    // Full image + reduced-resolution overviews, finest first
    const levels: { image: any, scale: number }[] = [{ image: first, scale: 1 }];
    const count: number = await tiff.getImageCount();
    for (let i = 1; i < count; i++) {
        const image = await tiff.getImage(i);
        const dir = image.fileDirectory;
        if (dir.SubfileType === 2 || (dir.NewSubfileType & 1)) {
            levels.push({ image, scale: fullW / image.getWidth() });
        }
    }
    levels.sort((a, b) => a.scale - b.scale);

    const [minX, minY, maxX, maxY] = first.getBoundingBox();
    const toMap = proj4(def, 'EPSG:4326');
    const corners = [[minX, minY], [minX, maxY], [maxX, minY], [maxX, maxY]].map(c => toMap.forward(c));
    const lons = corners.map(c => c[0]), lats = corners.map(c => c[1]);
    const bounds = L.latLngBounds(L.latLng(Math.min(...lats), Math.min(...lons)), L.latLng(Math.max(...lats), Math.max(...lons)));
    if (!bounds.isValid()) throw new Error('Cannot place this TIFF on the map.');

    // Zoom level at which one map pixel is as small as one pixel of the file
    const center = bounds.getCenter();
    const metersPerUnit = /\+proj=longlat/.test(def) ? 111320 : 1;
    const groundRes = Math.abs(rX) * metersPerUnit;
    const nativeZoom = Math.ceil(Math.log2(156543.03392 * Math.cos(center.lat * Math.PI / 180) / groundRes));

    const OrthoLayer = L.GridLayer.extend({
        createTile(coords: any, done: (err: any, tile: HTMLElement) => void) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = TILE;

            // Tile corners in the coordinates of the file: top-left, top-right, bottom-left, bottom-right
            const map: L.Map = this._map;
            const px = coords.x * TILE, py = coords.y * TILE;
            const c = [[px, py], [px + TILE, py], [px, py + TILE], [px + TILE, py + TILE]].map(p => {
                const ll = map.unproject(L.point(p[0], p[1]), coords.z);
                const xy = toSrc.forward([ll.lng, ll.lat]);
                // In pixels of the full-resolution image
                return [(xy[0] - oX) / rX, (xy[1] - oY) / rY];
            });

            const cols = c.map(p => p[0]), rows = c.map(p => p[1]);
            const c0 = Math.min(...cols), c1 = Math.max(...cols), r0 = Math.min(...rows), r1 = Math.max(...rows);
            if (!(c1 > 0 && r1 > 0 && c0 < fullW && r0 < fullH)) {
                setTimeout(() => done(null, canvas), 0);
                return canvas;
            }

            // Coarsest overview that still has one pixel per map pixel
            const wanted = Math.max(c1 - c0, r1 - r0) / TILE;
            let level = levels[0];
            for (const l of levels) {
                if (l.scale <= wanted) level = l;
            }
            const sx = fullW / level.image.getWidth(), sy = fullH / level.image.getHeight();
            const w = [
                Math.max(0, Math.floor(c0 / sx)), Math.max(0, Math.floor(r0 / sy)),
                Math.min(level.image.getWidth(), Math.ceil(c1 / sx) + 1), Math.min(level.image.getHeight(), Math.ceil(r1 / sy) + 1)
            ];
            const ww = w[2] - w[0], wh = w[3] - w[1];
            if (ww <= 0 || wh <= 0 || ww * wh > MAX_WINDOW_PIXELS) {
                setTimeout(() => done(null, canvas), 0);
                return canvas;
            }

            level.image.readRasters({ window: w, interleave: true }).then((data: Uint8Array) => {
                const ctx = canvas.getContext('2d');
                const out = ctx.createImageData(TILE, TILE);
                const o = out.data;

                for (let j = 0; j < TILE; j++) {
                    const v = (j + 0.5) / TILE;
                    // Left and right ends of this row, between the tile corners
                    const lc = c[0][0] + (c[2][0] - c[0][0]) * v, lr = c[0][1] + (c[2][1] - c[0][1]) * v;
                    const rc = c[1][0] + (c[3][0] - c[1][0]) * v, rr = c[1][1] + (c[3][1] - c[1][1]) * v;

                    for (let i = 0; i < TILE; i++) {
                        const u = (i + 0.5) / TILE;
                        const col = Math.floor((lc + (rc - lc) * u) / sx) - w[0];
                        const row = Math.floor((lr + (rr - lr) * u) / sy) - w[1];
                        if (col < 0 || row < 0 || col >= ww || row >= wh) continue;

                        const s = (row * ww + col) * spp;
                        const d = (j * TILE + i) * 4;
                        const r = data[s];
                        const g = colorBands === 3 ? data[s + 1] : r;
                        const b = colorBands === 3 ? data[s + 2] : r;
                        let a = alphaBand !== -1 ? data[s + alphaBand] : 255;
                        if (alphaBand === -1 && noData !== null && r === noData && g === noData && b === noData) a = 0;

                        o[d] = r; o[d + 1] = g; o[d + 2] = b; o[d + 3] = a;
                    }
                }

                ctx.putImageData(out, 0, 0);
                done(null, canvas);
            }).catch(err => done(err, canvas));

            return canvas;
        }
    });

    const layer = new (OrthoLayer as any)({
        attribution: 'Orthophoto: ' + escapeHtml(file.name),
        bounds,
        tileSize: TILE,
        minZoom: 0,
        maxNativeZoom: Math.max(1, nativeZoom),
        maxZoom: 99
    });
    return { name: file.name, layer, bounds };
}
