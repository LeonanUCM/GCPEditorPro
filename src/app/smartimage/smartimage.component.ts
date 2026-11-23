import { Component, Output, EventEmitter, Input, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { CoordsXY } from '../../shared/common';

const MAX_SCALE = 300;
const WHEEL_STEP = Math.exp(0.7 / 3);
const DRAG_THRESHOLD = 3;
// Zoom of an image that has a pin when it is first shown, centered on the pin
const PIN_ZOOM = 10;
const IDENTITY = [1, 0, 0, 1];

@Component({
    selector: 'app-smartimage',
    templateUrl: './smartimage.component.html',
    styleUrls: ['./smartimage.component.scss']
})
export class SmartimageComponent implements AfterViewInit, OnDestroy {

    // A pin set from outside (loaded file, detection) moves the view to it; a click of the user does not
    @Input()
    get pinLocation() {
        return this.pinLocationValue;
    }

    set pinLocation(val) {
        const moved = val !== this.pinLocationValue;
        this.pinLocationValue = val;
        if (val && moved) this.home();
        else this.render();
        this.pinLocationChange.emit(this.pinLocationValue);
    }

    @Output() public pin = new EventEmitter();
    @Input() public src: string;

    @Input()
    get crosshair() {
        return this.crosshairValue;
    }

    set crosshair(val) {
        this.crosshairValue = val;
        this.render();
    }

    crosshairValue = false;

    @Input()
    get size() {
        return this.sizeValue;
    }

    set size(val) {
        this.sizeValue = val;
        this.layout();
    }

    sizeValue = 320;

    // How the image is drawn: view = L * image pixel, L = [l00, l01, l10, l11] (null = as it is).
    // Used to show the photo with north up. The center of the view stays on the same place of the image.
    @Input()
    get orient() {
        return this.L;
    }

    set orient(val: number[]) {
        const next = val || IDENTITY;
        if (next.every((v, i) => Math.abs(v - this.L[i]) < 1e-6)) return;
        const center = this.viewToImage({ x: this.view.x + this.view.w / 2, y: this.view.y + this.view.h / 2 });
        this.L = next;
        if (this.naturalWidth === 0) return;
        const c = this.imageToView(center);
        this.view.x = c.x - this.view.w / 2;
        this.view.y = c.y - this.view.h / 2;
        this.clampView();
        this.render();
    }

    @ViewChild('img') img: ElementRef;
    @ViewChild('svg') svg: ElementRef;
    @ViewChild('content') content: ElementRef;
    @ViewChild('image') image: ElementRef;
    @ViewChild('pin') pinGroup: ElementRef;
    @ViewChild('cross') crossGroup: ElementRef;
    @ViewChild('msg') msgDiv: ElementRef;

    @Output()
    pinLocationChange = new EventEmitter<CoordsXY>();

    // The visible part or the size of the image changed (see viewInfo)
    @Output() viewChange = new EventEmitter<void>();

    pinLocationValue: CoordsXY = null;

    private L: number[] = IDENTITY;
    private naturalWidth = 0;
    private naturalHeight = 0;
    private displayWidth = 0;
    private displayHeight = 0;
    // Visible rectangle, in view coordinates (= image pixels when the image is not turned)
    private view = { x: 0, y: 0, w: 0, h: 0 };

    private pointer: { id: number, x: number, y: number, panning: boolean } = null;
    private hover: { x: number, y: number } = null;
    private wheelMessageTimeout: any;
    private listeners: [string, any][] = [];

    ngAfterViewInit(): void {
        const svg = this.svg.nativeElement;

        this.listen('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0 || this.pointer !== null) return;
            this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, panning: false };
            svg.setPointerCapture(e.pointerId);
        });

        this.listen('pointermove', (e: PointerEvent) => {
            this.hover = { x: e.clientX, y: e.clientY };
            const p = this.pointer;
            if (p === null || p.id !== e.pointerId) {
                this.renderCrosshair();
                return;
            }
            if (!p.panning && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
            if (!p.panning) {
                p.panning = true;
                svg.classList.add('panning');
            }
            const ctm = svg.getScreenCTM();
            this.view.x -= (e.clientX - p.x) / ctm.a;
            this.view.y -= (e.clientY - p.y) / ctm.d;
            p.x = e.clientX;
            p.y = e.clientY;
            this.clampView();
            this.render();
        });

        this.listen('pointerup', (e: PointerEvent) => {
            const p = this.pointer;
            if (p === null || p.id !== e.pointerId) return;
            this.pointer = null;
            svg.classList.remove('panning');
            if (p.panning || this.naturalWidth === 0) return;

            const pos = this.viewToImage(this.toView(e.clientX, e.clientY));
            pos.x = Math.min(Math.max(pos.x, 0), this.naturalWidth);
            pos.y = Math.min(Math.max(pos.y, 0), this.naturalHeight);

            this.pinLocationValue = pos;
            this.render();
            this.pinLocationChange.emit(pos);
            this.pin.emit(pos);
        });

        this.listen('pointercancel', () => {
            this.pointer = null;
            svg.classList.remove('panning');
        });

        this.listen('wheel', (e: WheelEvent) => {
            if (!e.shiftKey) {
                this.displayWheelMessage();
                return;
            }
            e.preventDefault();
            clearTimeout(this.wheelMessageTimeout);
            this.msgDiv.nativeElement.style.transitionDuration = '0s';
            this.msgDiv.nativeElement.style.opacity = 0;
            if (this.naturalWidth === 0) return;

            const delta = e.deltaY || e.deltaX;
            if (delta === 0) return;

            const scale = this.naturalWidth / this.view.w;
            const minScale = this.naturalWidth / this.fitWidth();
            const newScale = Math.min(MAX_SCALE, Math.max(minScale, delta < 0 ? scale * WHEEL_STEP : scale / WHEEL_STEP));
            const p = this.toView(e.clientX, e.clientY);
            const ratio = scale / newScale;

            this.view.x = p.x - (p.x - this.view.x) * ratio;
            this.view.y = p.y - (p.y - this.view.y) * ratio;
            this.view.w *= ratio;
            this.view.h *= ratio;
            this.clampView();
            this.render();
        });

        this.listen('mouseleave', () => {
            this.msgDiv.nativeElement.style.opacity = 0;
        });

        this.listen('pointerleave', () => {
            this.hover = null;
            this.renderCrosshair();
        });
    }

    ngOnDestroy() {
        const svg = this.svg.nativeElement;
        this.listeners.forEach(([type, fn]) => svg.removeEventListener(type, fn));
        clearTimeout(this.wheelMessageTimeout);
    }

    public onImageLoad() {
        const img = this.img.nativeElement;
        this.naturalWidth = img.naturalWidth;
        this.naturalHeight = img.naturalHeight;
        this.view = { x: 0, y: 0, w: this.naturalWidth, h: 0 };

        const image = this.image.nativeElement;
        image.setAttribute('width', this.naturalWidth);
        image.setAttribute('height', this.naturalHeight);
        image.setAttribute('href', img.currentSrc || img.src);

        this.layout();
        this.home();
    }

    private layout() {
        if (!this.svg || this.naturalWidth === 0) return;

        const fit = Math.min(1, this.sizeValue / this.naturalWidth, this.sizeValue / this.naturalHeight);
        this.displayWidth = Math.max(1, Math.round(this.naturalWidth * fit));
        this.displayHeight = Math.max(1, Math.round(this.naturalHeight * fit));
        this.view.h = this.view.w * this.displayHeight / this.displayWidth;

        const svg = this.svg.nativeElement;
        svg.setAttribute('width', this.displayWidth);
        svg.setAttribute('height', this.displayHeight);

        this.clampView();
        this.render();
    }

    // Default position: PIN_ZOOM on the pin, or the whole image when there is no pin
    private home() {
        if (!this.svg || this.naturalWidth === 0 || this.displayWidth === 0) return;

        const b = this.bounds();
        const pin = this.pinLocationValue;
        const c = pin ? this.imageToView(pin) : { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
        const w = pin ? this.naturalWidth / PIN_ZOOM : this.fitWidth();
        const h = w * this.displayHeight / this.displayWidth;
        this.view = { x: c.x - w / 2, y: c.y - h / 2, w, h };
        this.clampView();
        this.render();
    }

    /** Image pixels per screen pixel in the view, and the size of the image on the screen. null = not loaded. */
    public viewInfo(): { scale: number, width: number, height: number } {
        if (this.naturalWidth === 0 || this.displayWidth === 0) return null;
        return { scale: this.view.w / this.displayWidth, width: this.displayWidth, height: this.displayHeight };
    }

    public clearPin(){
        this.pinLocation = null;
    }

    private listen(type: string, fn: any) {
        this.svg.nativeElement.addEventListener(type, fn, type === 'wheel' ? { passive: false } : undefined);
        this.listeners.push([type, fn]);
    }

    private toView(clientX: number, clientY: number): CoordsXY {
        const svg = this.svg.nativeElement;
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        const p = pt.matrixTransform(svg.getScreenCTM().inverse());
        return { x: p.x, y: p.y };
    }

    private imageToView(p: CoordsXY): CoordsXY {
        const L = this.L;
        return { x: L[0] * p.x + L[1] * p.y, y: L[2] * p.x + L[3] * p.y };
    }

    private viewToImage(p: CoordsXY): CoordsXY {
        const L = this.L;
        const det = L[0] * L[3] - L[1] * L[2];
        return { x: (L[3] * p.x - L[1] * p.y) / det, y: (L[0] * p.y - L[2] * p.x) / det };
    }

    // Box of the image in view coordinates
    private bounds() {
        const pts = [[0, 0], [this.naturalWidth, 0], [0, this.naturalHeight], [this.naturalWidth, this.naturalHeight]]
            .map(([x, y]) => this.imageToView({ x, y }));
        const xs = pts.map(p => p.x);
        const ys = pts.map(p => p.y);
        return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    }

    // Width of the view that shows the whole image
    private fitWidth(): number {
        const b = this.bounds();
        return Math.max(b.x1 - b.x0, (b.y1 - b.y0) * this.displayWidth / this.displayHeight);
    }

    private clampView() {
        const b = this.bounds();
        this.view.x = Math.min(Math.max(this.view.x, b.x0 - this.view.w / 2), b.x1 - this.view.w / 2);
        this.view.y = Math.min(Math.max(this.view.y, b.y0 - this.view.h / 2), b.y1 - this.view.h / 2);
    }

    private render() {
        if (!this.svg || this.naturalWidth === 0) return;

        const v = this.view;
        const L = this.L;
        this.svg.nativeElement.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
        this.content.nativeElement.setAttribute('transform', `matrix(${L[0]} ${L[2]} ${L[1]} ${L[3]} 0 0)`);
        this.image.nativeElement.style.imageRendering = this.displayWidth * window.devicePixelRatio / v.w >= 1 ? 'pixelated' : 'auto';

        const g = this.pinGroup.nativeElement;
        if (this.pinLocationValue) {
            const s = v.w / this.displayWidth;
            const p = this.imageToView(this.pinLocationValue);
            g.setAttribute('transform', `translate(${p.x} ${p.y}) scale(${s})`);
            g.style.display = '';
        } else {
            g.style.display = 'none';
        }

        this.renderCrosshair();
        this.viewChange.emit();
    }

    private renderCrosshair() {
        if (!this.crossGroup) return;

        const g = this.crossGroup.nativeElement;
        if (!this.crosshairValue || this.hover === null || this.naturalWidth === 0) {
            g.style.display = 'none';
            return;
        }

        const v = this.view;
        const p = this.toView(this.hover.x, this.hover.y);
        const d = `M${p.x} ${v.y}V${v.y + v.h}M${v.x} ${p.y}H${v.x + v.w}`;
        for (const path of g.children) path.setAttribute('d', d);
        g.style.display = '';
    }

    private displayWheelMessage() {
        clearTimeout(this.wheelMessageTimeout);
        this.msgDiv.nativeElement.style.transitionDuration = '';
        this.msgDiv.nativeElement.style.opacity = 1;
        this.wheelMessageTimeout = setTimeout(() => {
            this.msgDiv.nativeElement.style.opacity = 0;
        }, 2000);
    }

}
