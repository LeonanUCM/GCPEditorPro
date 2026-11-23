import { AfterViewInit, Inject, Injectable, OnInit, Renderer2, RendererFactory2 } from '@angular/core';
import { CoordsXY } from '../shared/common';
import { NgOpenCVService, OpenCVLoadResult } from 'ng-open-cv';
import { BehaviorSubject, forkJoin, Observable } from 'rxjs';
import { tap, switchMap, filter, take } from 'rxjs/operators';
import { StorageService } from './storage.service';
import { DOCUMENT } from '@angular/common';
import { Point } from 'leaflet';

declare var cv: any;

@Injectable({
    providedIn: 'root'
})
export class GcpsDetectorService {

    private r2: Renderer2;

    constructor(private ngOpenCVService: NgOpenCVService,
        private storage: StorageService,
        rendererFactory: RendererFactory2,
        @Inject(DOCUMENT) private document: Document,
    ) {

        this.r2 = rendererFactory.createRenderer(null, null);
    }

    private areClassifiersLoaded: boolean;

    // *** Add here more classifiers ***
    private classifiers = [
        "gcp-square-base.xml",  
        "gcp-bw-quads.xml"
    ];

    loadClassifiers(): Promise<any> {

        return Promise.all(
            this.classifiers.map(c =>
                this.ngOpenCVService.createFileFromUrl(c, `assets/opencv/data/haarcascades/${c}`).toPromise())
        );
    }

    async detect(imgName: string): Promise<CoordsXY> {

        if (!this.areClassifiersLoaded) {
            await this.loadClassifiers();
            this.areClassifiersLoaded = true;
        }

        const url = await this.storage.getDisplayUrl(imgName);

        return new Promise<CoordsXY>((resolve, reject) => {

            const container = this.r2.createElement('div');
            this.r2.setStyle(container, 'position', 'absolute');
            this.r2.setStyle(container, 'top', '0');
            this.r2.setStyle(container, 'left', '0');
            this.r2.setStyle(container, 'width', '100%');
            this.r2.setStyle(container, 'height', '100%');
            this.r2.setStyle(container, 'opacity', '0');
            this.r2.setStyle(container, 'overflow', 'hidden');
            this.r2.setStyle(container, 'z-index', '-1');

            this.r2.appendChild(this.document.body, container);

            // This is a shitshow, but it works.
            const imgTag = this.r2.createElement('img');
            this.r2.setAttribute(imgTag, 'id', 'tmp-img');
            this.r2.setStyle(imgTag, 'display', 'block');

            this.r2.setAttribute(imgTag, 'src', url);

            this.r2.appendChild(container, imgTag);

            imgTag.onload = () => {

                try {
                    const img = cv.imread(imgTag);
                    const scale = 1.05;
                    const neighbors = 3;
                    const minSize = new cv.Size(30, 30);
                    const maxSize = new cv.Size(0, 0);

                    let res = null;

                    // console.log('loaded image with size: ', img.size());

                    for (let i = 0; i < this.classifiers.length; i++) {

                        // console.log("detecting with classifier: ", this.classifiers[i]);

                        const classifier = new cv.CascadeClassifier();
                        classifier.load(this.classifiers[i]);
                        const rects = new cv.RectVector();

                        classifier.detectMultiScale(img, rects, scale, neighbors, 0, minSize, maxSize);

                        // We cant estimate the quality of the match, so we just return the first one
                        if (rects.size() > 0) {

                            const rect = rects.get(0);

                            res = { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2) };

                            // console.log("Found GCP at ", res);

                            rects.delete();
                            classifier.delete();

                            break;

                        } else
                            // console.log("No GCP found");

                        rects.delete();
                        classifier.delete();

                    }

                    this.r2.removeChild(this.document.body, container);
                    img.delete();

                    resolve(res);

                } catch (e) {
                    reject(e);
                }
            };

            imgTag.onerror = () => {
                this.r2.removeChild(this.document.body, container);
                reject('Cannot load ' + imgName);
            };
        });

    }

    // Visual fine adjustment of a suggested tag, with the OpenCV already loaded for the detector above:
    // a patch of ground around a tag that is known to be good (the reference) is searched around the
    // suggested tag of another photo with cv.matchTemplate (normalized correlation). Both patches are cut
    // with cv.warpAffine to the same ground frame (north up, same meters per pixel), using the local
    // ground map `A` of each photo (exif-projector.ts, groundAffine), so photos taken from different
    // sides and heights can be compared.

    private async loadImage(imgName: string): Promise<HTMLImageElement> {
        await this.ngOpenCVService.isReady$.pipe(filter((r: OpenCVLoadResult) => r.ready), take(1)).toPromise();
        const url = await this.storage.getDisplayUrl(imgName);
        return new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject('Cannot load ' + imgName);
            img.src = url;
        });
    }

    /**
     * Gray patch of `size` x `size` pixels of ground centered on the pixel (x, y) of the photo, north up,
     * `gsd` meters per pixel. null when the patch is outside the photo.
     */
    private groundPatch(img: HTMLImageElement, x: number, y: number, A: number[], gsd: number, size: number): any {
        // patch (u, v) -> photo = (x, y) + B * (u - half, v - half)
        const B = [A[0] * gsd, -A[1] * gsd, A[2] * gsd, -A[3] * gsd];
        const half = (size - 1) / 2;
        const at = (u: number, v: number) => [x + B[0] * (u - half) + B[1] * (v - half), y + B[2] * (u - half) + B[3] * (v - half)];

        // Only the piece of the photo under the patch goes to OpenCV
        const corners = [at(0, 0), at(size, 0), at(0, size), at(size, size)];
        const x0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[0]))) - 2);
        const y0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[1]))) - 2);
        const x1 = Math.min(img.naturalWidth, Math.ceil(Math.max(...corners.map(c => c[0]))) + 2);
        const y1 = Math.min(img.naturalHeight, Math.ceil(Math.max(...corners.map(c => c[1]))) + 2);
        if (x1 - x0 < 8 || y1 - y0 < 8) return null;

        const canvas = this.document.createElement('canvas');
        canvas.width = x1 - x0;
        canvas.height = y1 - y0;
        canvas.getContext('2d').drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);

        const rgba = cv.imread(canvas), gray = new cv.Mat(), patch = new cv.Mat();
        cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
        const origin = at(0, 0);
        const M = cv.matFromArray(2, 3, cv.CV_64F, [B[0], B[1], origin[0] - x0, B[2], B[3], origin[1] - y0]);
        cv.warpAffine(gray, patch, M, new cv.Size(size, size), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_CONSTANT, new cv.Scalar());
        rgba.delete(); gray.delete(); M.delete();
        return patch;
    }

    /** Reference of the fine adjustment: the ground around the tag (x, y) of a photo. Call `delete()` at the end. */
    async visualReference(imgName: string, x: number, y: number, A: number[]): Promise<VisualReference> {
        const img = await this.loadImage(imgName);
        // Ground resolution of the reference photo
        const gsd = 1 / Math.sqrt(Math.abs(A[0] * A[3] - A[1] * A[2]));
        const patch = this.groundPatch(img, x, y, A, gsd, VISUAL_TEMPLATE);
        if (!patch) throw new Error('The reference tag is outside ' + imgName);
        return { patch, gsd, delete: () => patch.delete() };
    }

    /**
     * Place of the reference in another photo, searched up to VISUAL_RADIUS reference pixels around the
     * suggested tag (x, y). `score` = normalized correlation (1 = same picture). null when the best place
     * is on the edge of the searched area (the real one may be outside).
     */
    async visualMatch(ref: VisualReference, imgName: string, x: number, y: number, A: number[]): Promise<{ x: number, y: number, score: number }> {
        const img = await this.loadImage(imgName);
        const search = this.groundPatch(img, x, y, A, ref.gsd, VISUAL_TEMPLATE + 2 * VISUAL_RADIUS);
        if (!search) return null;

        const res = new cv.Mat(), mask = new cv.Mat();
        cv.matchTemplate(search, ref.patch, res, cv.TM_CCOEFF_NORMED);
        const best = cv.minMaxLoc(res, mask);
        search.delete(); res.delete(); mask.delete();

        const du = best.maxLoc.x - VISUAL_RADIUS, dv = best.maxLoc.y - VISUAL_RADIUS;
        if (Math.max(Math.abs(du), Math.abs(dv)) >= VISUAL_RADIUS) return null;
        return {
            x: x + (A[0] * du - A[1] * dv) * ref.gsd,
            y: y + (A[2] * du - A[3] * dv) * ref.gsd,
            score: best.maxVal
        };
    }

}

// Side of the reference patch and how far around the suggested tag it is searched, in reference pixels
const VISUAL_TEMPLATE = 65;
const VISUAL_RADIUS = 250;

export interface VisualReference {
    patch: any;
    gsd: number;
    delete: () => void;
}
