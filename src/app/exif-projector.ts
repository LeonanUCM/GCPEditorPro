// Where a ground point falls in a photo, from the pose the drone wrote in the photo (EXIF + XMP).
//
// Pose of a photo: GPS latitude/longitude (EXIF), height over the take-off point and gimbal yaw, pitch
// and roll (XMP drone-dji), focal length in 35 mm format (EXIF). The camera is a plain pinhole: lens
// distortion is ignored.
//
// All points are in a local frame in meters centered on the GCP: x = east, y = north, z = up from the
// take-off level. The pose has the error of the drone (GPS: a few meters; height: relative to the
// take-off, not to the ground under the GCP), so the result is a suggestion to adjust by hand. Photos
// already tagged by the user correct most of it: the point is triangulated from their rays and that
// point, not the map coordinate, is projected into the other photos.
import exifr from 'exifr';

const EARTH_RADIUS = 6378137;
const FULL_FRAME_DIAGONAL = 43.2666; // mm, 36 x 24
// Two tagged photos must see the point from directions at least this far apart (15 degrees) to
// trust the height of the triangulated point
const MIN_PARALLAX_COS = Math.cos(15 * Math.PI / 180);

export type Vec = [number, number, number];

export interface PhotoPose {
    lat: number;
    lng: number;
    height: number;   // m over the take-off point
    yaw: number;      // degrees clockwise from north
    pitch: number;    // degrees, 0 = horizon, -90 = straight down
    roll: number;     // degrees
    focal35: number;  // mm, 35 mm equivalent
    width: number;    // pixels of the file being tagged
    height_px: number;
}

export interface Camera {
    center: Vec;
    forward: Vec;
    right: Vec;
    down: Vec;
    focal: number;    // pixels
    width: number;
    height: number;
}

const num = (v: any): number => {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return isFinite(n) ? n : NaN;
};

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix = (a: Vec, ka: number, b: Vec, kb: number): Vec => [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];

// Pixel size written in the JPEG frame header (SOF), without decoding the picture: reading the pose of
// a whole flight must not decode hundreds of 12 MP photos
async function jpegSize(file: File): Promise<{ w: number, h: number }> {
    try {
        const d = new DataView(await new Response(file.slice(0, 1024 * 1024)).arrayBuffer());
        if (d.byteLength < 4 || d.getUint16(0) !== 0xFFD8) return null;
        let p = 2;
        while (p + 9 < d.byteLength) {
            if (d.getUint8(p) !== 0xFF) return null;
            const marker = d.getUint8(p + 1);
            if (marker === 0xFF) { p++; continue; }
            // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC)
            if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                const h = d.getUint16(p + 5), w = d.getUint16(p + 7);
                return w > 0 && h > 0 ? { w, h } : null;
            }
            if (marker === 0xDA) return null;
            p += 2 + d.getUint16(p + 2);
        }
    } catch (e) { }
    return null;
}

// Pixel size of the file (the EXIF may still carry the size of the original after a resize)
async function imageSize(file: File, url: string, tags: any): Promise<{ w: number, h: number }> {
    const fromTags = () => {
        const w = num(tags.ImageWidth) || num(tags.ExifImageWidth), h = num(tags.ImageHeight) || num(tags.ExifImageHeight);
        return w > 0 && h > 0 ? { w, h } : null;
    };
    if (/\.tiff?$/i.test(file.name) || !url) return fromTags();
    const header = await jpegSize(file);
    if (header) return header;

    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve(fromTags());
        img.src = url;
    });
}

/** Pose written by the drone in the photo, or null when a piece is missing. */
export async function readPhotoPose(file: File, url: string): Promise<PhotoPose> {
    let tags: any;
    try {
        tags = await exifr.parse(file, { tiff: true, ifd0: true, exif: true, gps: true, xmp: true } as any);
    } catch (e) {
        return null;
    }
    if (!tags) return null;

    const yaw = isFinite(num(tags.GimbalYawDegree)) ? num(tags.GimbalYawDegree) : num(tags.FlightYawDegree);
    const pose = {
        lat: num(tags.latitude),
        lng: num(tags.longitude),
        height: num(tags.RelativeAltitude),
        yaw,
        pitch: num(tags.GimbalPitchDegree),
        roll: isFinite(num(tags.GimbalRollDegree)) ? num(tags.GimbalRollDegree) : 0,
        focal35: num(tags.FocalLengthIn35mmFormat),
        width: 0,
        height_px: 0
    };
    if (![pose.lat, pose.lng, pose.height, pose.yaw, pose.pitch, pose.focal35].every(isFinite) || pose.focal35 <= 0) return null;

    const size = await imageSize(file, url, tags);
    if (!size) return null;
    pose.width = size.w;
    pose.height_px = size.h;
    return pose;
}

/** Camera in the local frame centered on (lat0, lng0). */
export function cameraFromPose(pose: PhotoPose, lat0: number, lng0: number): Camera {
    const rad = Math.PI / 180;
    const center: Vec = [
        (pose.lng - lng0) * rad * EARTH_RADIUS * Math.cos(lat0 * rad),
        (pose.lat - lat0) * rad * EARTH_RADIUS,
        pose.height
    ];

    const y = pose.yaw * rad, p = pose.pitch * rad, r = pose.roll * rad;
    const forward: Vec = [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)];
    const right0: Vec = [Math.cos(y), -Math.sin(y), 0];
    const down0 = cross(forward, right0);
    // Roll turns the image axes around the optical axis
    const right = mix(right0, Math.cos(r), down0, Math.sin(r));
    const down = mix(right0, -Math.sin(r), down0, Math.cos(r));

    const focal = pose.focal35 / FULL_FRAME_DIAGONAL * Math.hypot(pose.width, pose.height_px);
    return { center, forward, right, down, focal, width: pose.width, height: pose.height_px };
}

/**
 * Distance on the ground (meters) from the GCP to the place the photo looks at: where the optical axis
 * meets the take-off level. For a nadir photo it is the distance to the drone; an oblique photo looks at
 * a place far from the drone, and the distance to the drone would leave it out of the distance filter.
 */
export function viewDistance(cam: Camera): number {
    const h = cam.center[2];
    // Looking at the horizon or flying under the take-off level: the distance to the drone
    if (cam.forward[2] > -0.05 || h <= 0) return Math.hypot(cam.center[0], cam.center[1]);
    const t = Math.min(-h / cam.forward[2], 10 * h);
    return Math.hypot(cam.center[0] + t * cam.forward[0], cam.center[1] + t * cam.forward[1]);
}

/**
 * Pixel where the point falls, or null when it is behind the camera or outside the frame.
 * @param outside the pose has an error of about 100 px in a 4096 px photo, so a point near the border may
 *   come out just outside: up to this many pixels outside it is still accepted and placed on the border
 * `offset` = distance from the center of the photo, 0 (center) to 1 (corner), before placing on the border.
 */
export function project(cam: Camera, point: Vec, outside = 0): { x: number, y: number, offset: number } {
    const v: Vec = [point[0] - cam.center[0], point[1] - cam.center[1], point[2] - cam.center[2]];
    const z = dot(v, cam.forward);
    if (z <= 0.1) return null;
    const x = cam.width / 2 + cam.focal * dot(v, cam.right) / z;
    const y = cam.height / 2 + cam.focal * dot(v, cam.down) / z;
    if (x < -outside || y < -outside || x > cam.width + outside || y > cam.height + outside) return null;
    return {
        x: Math.min(Math.max(x, 1), cam.width - 1),
        y: Math.min(Math.max(y, 1), cam.height - 1),
        offset: centerOffset(cam, x, y)
    };
}

/**
 * Local map from the ground to the photo around a point: pixel of the point and
 * A = d(pixel) / d(east, north) in pixels per meter, [dx/dE, dx/dN, dy/dE, dy/dN]. The ground is taken
 * as horizontal at the height of the point. null when the point is behind the camera.
 */
export function groundAffine(cam: Camera, point: Vec): { x: number, y: number, A: number[] } {
    const pixel = (p: Vec) => {
        const v: Vec = [p[0] - cam.center[0], p[1] - cam.center[1], p[2] - cam.center[2]];
        const z = dot(v, cam.forward);
        return z <= 0.1 ? null : [cam.width / 2 + cam.focal * dot(v, cam.right) / z, cam.height / 2 + cam.focal * dot(v, cam.down) / z];
    };
    const p = pixel(point), e = pixel([point[0] + 0.5, point[1], point[2]]), n = pixel([point[0], point[1] + 0.5, point[2]]);
    if (!p || !e || !n) return null;
    return { x: p[0], y: p[1], A: [(e[0] - p[0]) * 2, (n[0] - p[0]) * 2, (e[1] - p[1]) * 2, (n[1] - p[1]) * 2] };
}

/**
 * How to draw the photo with north up and east to the right, so photos taken from different sides can
 * be compared: view = L * pixel, L = [l00, l01, l10, l11], same area as the photo. It is the ground map
 * of `groundAffine` undone, so an oblique photo is also stretched back to the shape of the ground; a photo
 * that looks too flat over the ground (stretch over 3x) is only turned.
 * The map is taken at `point` if the photo sees it, otherwise at the place the photo looks at.
 */
export function northUp(cam: Camera, point: Vec): number[] {
    let g = groundAffine(cam, point);
    if (!g || g.x < -cam.width || g.x > 2 * cam.width || g.y < -cam.height || g.y > 2 * cam.height) {
        const h = cam.center[2] - point[2];
        const t = cam.forward[2] < -0.05 && h > 0 ? Math.min(-h / cam.forward[2], 10 * h) : 50;
        g = groundAffine(cam, [cam.center[0] + t * cam.forward[0], cam.center[1] + t * cam.forward[1], cam.center[2] + t * cam.forward[2]]);
    }
    if (!g) return null;
    const [a, b, c, d] = g.A, det = a * d - b * c;
    if (!isFinite(det) || Math.abs(det) < 1e-9) return null;

    const k = Math.sqrt(Math.abs(det)) / det;
    const L = [k * d, -k * b, k * c, -k * a];
    // The two stretches of L multiply to 1: s + 1/s = sqrt(sum of squares + 2)
    if (Math.sqrt(L[0] * L[0] + L[1] * L[1] + L[2] * L[2] + L[3] * L[3] + 2) <= 3 + 1 / 3) return L;

    const turn = -Math.PI / 2 - Math.atan2(d, b);
    return [Math.cos(turn), -Math.sin(turn), Math.sin(turn), Math.cos(turn)];
}

/** Distance of a pixel from the center of the photo: 0 = center, 1 = corner. */
export function centerOffset(cam: Camera, x: number, y: number): number {
    return Math.hypot(x - cam.width / 2, y - cam.height / 2) / Math.hypot(cam.width / 2, cam.height / 2);
}

function ray(cam: Camera, x: number, y: number): Vec {
    const a = (x - cam.width / 2) / cam.focal, b = (y - cam.height / 2) / cam.focal;
    const d: Vec = [
        cam.forward[0] + a * cam.right[0] + b * cam.down[0],
        cam.forward[1] + a * cam.right[1] + b * cam.down[1],
        cam.forward[2] + a * cam.right[2] + b * cam.down[2]
    ];
    const n = Math.hypot(d[0], d[1], d[2]);
    return [d[0] / n, d[1] / n, d[2] / n];
}

/**
 * Position of the point in the local frame.
 *  - 2 or more tagged photos with enough parallax: the point closest to their rays.
 *  - otherwise, with tagged photos: where their rays cross the take-off level (average).
 *  - no tagged photo: the map coordinate at the take-off level.
 * @param tags pixel tagged by the user in each camera
 * @param maxOffset a result farther than this from the map coordinate is not trusted (meters)
 */
export function locatePoint(tags: { cam: Camera, x: number, y: number }[], maxOffset = 100): { point: Vec, from: 'map' | 'one' | 'rays' } {
    const fallback = { point: [0, 0, 0] as Vec, from: 'map' as 'map' };
    if (tags.length === 0) return fallback;

    const rays = tags.map(t => ({ c: t.cam.center, d: ray(t.cam, t.x, t.y) }));
    const trusted = (p: Vec) => p.every(isFinite) && Math.hypot(p[0], p[1]) <= maxOffset && Math.abs(p[2]) <= maxOffset;

    if (rays.length >= 2) {
        // Least squares: sum(I - d d^T) P = sum(I - d d^T) C
        const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
        rays.forEach(({ c, d }) => {
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    const m = (i === j ? 1 : 0) - d[i] * d[j];
                    A[i][j] += m;
                    b[i] += m * c[j];
                }
            }
        });
        const det = (m: number[][]) =>
            m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
            m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
            m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        const D = det(A);
        // Rays almost parallel (photos taken from nearly the same place): the height is not defined
        let spread = 1;
        rays.forEach(r1 => rays.forEach(r2 => spread = Math.min(spread, dot(r1.d, r2.d))));
        if (spread < MIN_PARALLAX_COS && D > 1e-9) {
            const col = (k: number) => A.map((row, i) => row.map((v, j) => j === k ? b[i] : v));
            const p: Vec = [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
            if (trusted(p)) return { point: p, from: 'rays' };
        }
    }

    const hits = rays.filter(r => r.d[2] < -0.05).map(({ c, d }) => {
        const t = -c[2] / d[2];
        return [c[0] + t * d[0], c[1] + t * d[1]];
    });
    if (hits.length === 0) return fallback;
    const p: Vec = [hits.reduce((s, h) => s + h[0], 0) / hits.length, hits.reduce((s, h) => s + h[1], 0) / hits.length, 0];
    return trusted(p) ? { point: p, from: 'one' } : fallback;
}
