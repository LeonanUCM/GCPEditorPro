import { Component, OnInit, OnDestroy, ElementRef, ViewChild, ApplicationRef, TemplateRef, ViewChildren, QueryList, NgZone } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { StorageService } from '../storage.service';
import { ImageGcp, GCP } from '../gcps-utils.service';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser'

import * as rfdc from 'rfdc';
import proj4 from "proj4";
import * as L from 'leaflet';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog.component';
import { GcpsDetectorService } from '../gcps-detector.service';
import { CoordsXY, CoordsXYZ, GPSCoords } from '../../shared/common';
import { getDistanceFromLatLonInM, toHumanDistance } from 'src/shared/utils';
import { SmartimageComponent } from '../smartimage/smartimage.component';
import { Camera, Vec, readPhotoPose, cameraFromPose, project, locatePoint, viewDistance, centerOffset, groundAffine, northUp } from '../exif-projector';

// How far outside the frame a projected point is still suggested, as a fraction of the longer side
const EXIF_OUTSIDE = 0.04;
// Visual fine adjustment: a match under this normalized correlation is not used (the tag stays where
// the pose puts it)
const VISUAL_MIN_SCORE = 0.6;

const clone = rfdc();

@Component({
    selector: 'app-images-tagger',
    templateUrl: './images-tagger.component.html',
    styleUrls: ['./images-tagger.component.scss']
})
export class ImagesTaggerComponent implements OnInit, OnDestroy {

    public gcp: GCP;
    public gcpCoords: CoordsXYZ;
    public errors: string[] = [];

    public isLoading = false;
    public loadingMessage = null;
    public loadingProgress: number = 0;
    public allowProgressClose: boolean = false;

    public filterDistance: number = 0;
    public filterByDistance: boolean = true;

    public showFilterSettings: boolean = false;

    public columns: number = 4;
    public showColumnsSettings: boolean = false;
    public imageSize: number = 320;
    public showCrosshair: boolean = localStorage.getItem("crosshair") !== "0";

    @ViewChild('grid') grid: ElementRef;
    private gridObserver = null;

    public images: ImageDescriptor[] = [];
    public rawImages: ImageDescriptor[] = [];

    public page: number = 1;

    // "Detect GCPs based on GPS/EXIF": camera of each photo (null = no pose in the file) and last result
    private exifCameras: { [imgName: string]: Camera } = {};
    public exifResult: string = null;
    // Where the GCP is in the local frame of the cameras (the map coordinate until a detection locates it)
    private exifPoint: Vec = [0, 0, 0];

    // Options of the dialog of "Detect GCPs based on GPS/EXIF"
    @ViewChild('exifDialog') exifDialog: TemplateRef<any>;
    public exifMax: number = parseInt(localStorage.getItem("exifMax")) >= 0 ? parseInt(localStorage.getItem("exifMax")) : 20;
    public exifVisual: boolean = localStorage.getItem("exifVisual") === "1";

    // Photos drawn with north up, to compare the same place seen from different sides
    public northUp: boolean = localStorage.getItem("northUp") === "1";

    // Map reference: in front of the first photo, the place of the GCP on the base layer of the GCP map,
    // at the ground scale the first photo is shown at (it follows the zoom of that photo)
    public showReference: boolean = localStorage.getItem("mapReference") !== "0";
    public referenceSize = { width: 320, height: 240 };
    public referenceEmpty: boolean = false;
    private referenceMap: L.Map = null;
    private referenceTimer: any = null;

    @ViewChild('referenceMap') set referenceMapElement(el: ElementRef) {
        if (el && !this.referenceMap) {
            this.zone.runOutsideAngular(() => {
                this.referenceMap = L.map(el.nativeElement, {
                    zoomControl: false, attributionControl: false, zoomSnap: 0, maxZoom: 99, zoomAnimation: false, fadeAnimation: false,
                    dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false
                }).setView([this.gcpCoords.y, this.gcpCoords.x], 20);
                const layer = this.storage.mapBaseLayer ? this.storage.mapBaseLayer() : null;
                if (layer) layer.addTo(this.referenceMap);
                setTimeout(() => this.referenceEmpty = !layer, 0);
            });
            this.scheduleReference();
        } else if (!el && this.referenceMap) {
            this.referenceMap.remove();
            this.referenceMap = null;
        }
    }

    // This page size is a "safe" number, we could use a bigger one but we risk to nuke the browser
    private readonly pageCells: number = 10;

    // Photos per page: the map reference takes one of the cells, so the rows stay full
    public get pageSize(): number {
        return this.pageCells - (this.showReference ? 1 : 0);
    }

    @ViewChild('dnd') dnd: ElementRef;
    private handleDrop = null;
    private handleWindowClick = () => this.closeFilterSettings();

    @ViewChild('imagesUpload') imagesUpload: ElementRef;
    @ViewChildren('smartImage') smartImages:QueryList<SmartimageComponent>;

    constructor(private router: Router,
        private route: ActivatedRoute,
        private storage: StorageService,
        private sanitizer: DomSanitizer,
        private appRef: ApplicationRef,
        private modalService: NgbModal,
        private detector: GcpsDetectorService,
        private zone: NgZone) {

        if (typeof storage.gcps === 'undefined' ||
            storage.gcps === null ||
            storage.gcps.length === 0 ||
            typeof storage.projection === 'undefined' ||
            storage.projection === null) {

            router.navigateByUrl('/');
            return;
        }

        this.filterDistance = localStorage.getItem("filterDistance") !== null ? 
                                (parseFloat(localStorage.getItem("filterDistance")) || 30) : 
                                30;

        const columns = parseInt(localStorage.getItem("columns"));
        if (columns >= 1 && columns <= 6) this.columns = columns;
    }

    ngOnDestroy(): void {
        clearTimeout(this.referenceTimer);
        if (this.referenceMap) {
            this.referenceMap.remove();
            this.referenceMap = null;
        }
        if (this.handleDrop) window.removeEventListener("droppedFiles", this.handleDrop);
        window.removeEventListener("click", this.handleWindowClick);
        if (this.gridObserver) this.gridObserver.disconnect();
    }

    ngAfterViewInit(): void {

        this.handleDrop = e => {
            this.handleImages(e.detail.files);
        };
        window.addEventListener("droppedFiles", this.handleDrop);
        window.addEventListener("click", this.handleWindowClick);
        if (this.grid) {
            this.gridObserver = new (window as any).ResizeObserver(() => this.zone.run(() => this.updateImageSize()));
            this.gridObserver.observe(this.grid.nativeElement);
        }
    }

    public updateImageSize(){
        if (!this.grid) return;
        const el = this.grid.nativeElement;
        const style = getComputedStyle(el);
        const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        this.imageSize = Math.max(1, Math.floor(width / this.columns) - 2);
    }


    ngOnInit(): void {

        const gcpName = this.route.snapshot.paramMap.get('gcp');

        if (typeof gcpName === 'undefined' || gcpName === null) {
            this.router.navigateByUrl('/');
            return;
        }

        const matches = this.storage.gcps.filter(gcp => gcp.name === gcpName);

        if (matches.length === 0) {
            console.warn('Cannot find matching GCP');
            this.router.navigateByUrl('/');
            return;
        }
    
        this.images = [];

        this.gcp = matches[0];

        // console.log("Using projection: ", this.storage.projection);

        // We need this to be able to calculate the distance
        let coords = proj4(
            this.storage.projection.eq,
            'EPSG:4326').forward([this.gcp.easting, this.gcp.northing, this.gcp.elevation], false);
        this.gcpCoords = new CoordsXYZ();
        this.gcpCoords.x = coords[0];
        this.gcpCoords.y = coords[1];
        if (coords.length === 3) this.gcpCoords.z = coords[2];

        // console.log("GCP coords: ", this.gcpCoords);

        if (this.storage.images.length === 0)
            return;

        this.rawImages = this.storage.images.map(img => {

            const gcps = this.storage.imageGcps.filter(imgGcp => imgGcp.imgName === img.name);
            const res = gcps.find(item => item.gcpName === gcpName);

            let obj = null;

            var coord = img.getCoords();

            if (res) {
                
                obj = {
                    image: {
                        gcpName: this.gcp.name,
                        geoX: this.gcp.easting,
                        geoY: this.gcp.northing,
                        geoZ: this.gcp.elevation,
                        imX: res.imX,
                        imY: res.imY,
                        imgName: img.name,
                        extras: []
                    },
                    isTagged: res.imX !== 0 && res.imY !== 0,
                    pinLocation: { x: res.imX, y: res.imY },
                    imageUrl: this.storage.getImageUrl(img.name) !== null ? this.sanitizer.bypassSecurityTrustResourceUrl(this.storage.getImageUrl(img.name)) : null,
                    otherGcps: gcps.map(gcp => gcp.gcpName),
                    coords: coord,
                    distance: null,
                    displayUrl: null,
                    displayUrlRaw: null,
                    displayError: null
                };
            } else {
                obj = {
                    image: {
                        gcpName: this.gcp.name,
                        geoX: this.gcp.easting,
                        geoY: this.gcp.northing,
                        geoZ: this.gcp.elevation,
                        imX: 0,
                        imY: 0,
                        imgName: img.name,
                        extras: []
                    },
                    isTagged: false,
                    pinLocation: null,
                    imageUrl: this.storage.getImageUrl(img.name) !== null ? this.sanitizer.bypassSecurityTrustResourceUrl(this.storage.getImageUrl(img.name)) : null,
                    otherGcps: gcps.map(gcp => gcp.gcpName),
                    coords: coord,
                    distance: null,
                    displayUrl: null,
                    displayUrlRaw: null,
                    displayError: null
                };
            }

            return obj;

        });

        this.loadImages(0);

        Promise.all(this.rawImages.map(item => item.coords)).then(coords => {
            for (let i = 0; i < coords.length; i++) {
                var coord = coords[i];
                var item = this.rawImages[i];

                if (coord) {
                    item.distance = getDistanceFromLatLonInM(this.gcpCoords.y, this.gcpCoords.x, coord.lat, coord.lng);
                    // console.log(item.image.imgName, coord, "Distance: " + item.distance);
                }
            }

            this.filterImages();

            this.setProgress("", 1, true);

        });

    }

    public toggleFilterByDistance(){
        this.filterByDistance = !this.filterByDistance;
        this.filterImages();
        if (!this.filterByDistance) this.showFilterSettings = false;
    }

    public updateDistanceRange(e){
        setTimeout(() => this.filterImages(), 1);
    }

    public closeFilterSettings(){
        this.showFilterSettings = false;
        this.showColumnsSettings = false;
    }

    public toggleCrosshair(){
        this.showCrosshair = !this.showCrosshair;
        localStorage.setItem("crosshair", this.showCrosshair ? "1" : "0");
    }

    public toggleReference(){
        this.showReference = !this.showReference;
        localStorage.setItem("mapReference", this.showReference ? "1" : "0");
        // The number of photos per page changed
        this.page = Math.max(1, Math.min(this.page, Math.ceil(this.images.length / this.pageSize)));
        this.loadVisibleImages();
    }

    // Called on every change of the view of a photo: the reference follows the first photo of the page
    public scheduleReference(){
        if (!this.showReference || this.referenceTimer) return;
        this.referenceTimer = setTimeout(() => {
            this.referenceTimer = null;
            this.updateReference();
        }, 50);
    }

    private async updateReference(){
        if (!this.referenceMap) return;
        const first = this.images[(this.page - 1) * this.pageSize];
        const smart = first && this.smartImages ? this.smartImages.find(si => si.src === first.displayUrl) : null;
        const info = smart ? smart.viewInfo() : null;
        if (!info) return;

        if (info.width !== this.referenceSize.width || info.height !== this.referenceSize.height) {
            this.referenceSize = { width: info.width, height: info.height };
            this.appRef.tick();
            this.referenceMap.invalidateSize({ animate: false } as any);
        }

        // Meters of ground per screen pixel in the first photo -> zoom of the map with the same scale
        const cam = await this.camera(first.image.imgName);
        const ground = cam ? groundAffine(cam, this.exifPoint) : null;
        if (!ground || !this.referenceMap) return;
        const metersPerPixel = info.scale / Math.sqrt(Math.abs(ground.A[0] * ground.A[3] - ground.A[1] * ground.A[2]));
        const zoom = Math.log2(156543.03392 * Math.cos(this.gcpCoords.y * Math.PI / 180) / metersPerPixel);
        if (isFinite(zoom)) this.referenceMap.setView([this.gcpCoords.y, this.gcpCoords.x], zoom, { animate: false });
    }

    public toggleNorthUp(){
        this.northUp = !this.northUp;
        localStorage.setItem("northUp", this.northUp ? "1" : "0");
        this.loadVisibleImages();
    }

    // Camera of a photo from the pose the drone wrote in it (null = no pose in the file)
    private async camera(name: string): Promise<Camera> {
        if (this.exifCameras[name] === undefined) {
            const info = this.storage.images.find(item => item.name === name);
            const pose = info && info.file ? await readPhotoPose(info.file, info.url) : null;
            this.exifCameras[name] = pose ? cameraFromPose(pose, this.gcpCoords.y, this.gcpCoords.x) : null;
        }
        return this.exifCameras[name];
    }

    public openExifDialog(){
        this.modalService.open(this.exifDialog, { ariaLabelledBy: 'exif-dialog-title' }).result.then(result => {
            if (result !== 'detect') return;
            this.exifMax = Math.max(0, Math.floor(this.exifMax) || 0);
            localStorage.setItem("exifMax", this.exifMax.toString());
            localStorage.setItem("exifVisual", this.exifVisual ? "1" : "0");
            this.detectByExif();
        }, () => {});
    }

    public toggleColumnsSettings(){
        this.showColumnsSettings = !this.showColumnsSettings;
    }

    public setColumns(n: number){
        this.columns = n;
        this.showColumnsSettings = false;
        localStorage.setItem("columns", n.toString());
        this.updateImageSize();
    }

    public filterImages() {

        // console.log("Filtering images with " + this.filterDistance + "m distance");
        
        this.page = 1;

        // Tagged first. Inside each group: the images where the point falls closer to the center of
        // the photo first (known after "Detect GCPs based on GPS/EXIF"), then by distance, then by name
        const order = (a: ImageDescriptor, b: ImageDescriptor) => {
            if (a.isTagged !== b.isTagged) return a.isTagged ? -1 : 1;
            const ca = a.centerOffset != null, cb = b.centerOffset != null;
            if (ca && cb && a.centerOffset !== b.centerOffset) return a.centerOffset > b.centerOffset ? 1 : -1;
            if (ca !== cb) return ca ? -1 : 1;
            if (this.filterByDistance && a.distance !== null && b.distance !== null && a.distance !== b.distance) return a.distance > b.distance ? 1 : -1;
            return a.image.imgName.localeCompare(b.image.imgName);
        };

        this.images = (this.filterByDistance) ? this.rawImages
            .filter(img => img.distance == null || img.distance < this.filterDistance)
            .sort(order) : this.rawImages.sort(order);

        if (this.filterByDistance){
            localStorage.setItem("filterDistance", this.filterDistance.toString());
        }

        this.loadVisibleImages();
    }

    public pageChanged(page: number) {
        this.page = page;
        this.loadVisibleImages();
    }

    private loadVisibleImages() {
        this.scheduleReference();
        const visible = this.images.slice((this.page - 1) * this.pageSize, this.page * this.pageSize);

        for (const desc of visible) {
            if (desc.imageUrl === null) continue;

            if (this.northUp) {
                this.camera(desc.image.imgName).then(cam => desc.north = cam ? northUp(cam, this.exifPoint) : null);
            }

            if (!this.storage.hasDisplayUrl(desc.image.imgName)) {
                desc.displayUrl = desc.displayUrlRaw = desc.displayError = null;
            }

            this.storage.getDisplayUrl(desc.image.imgName).then(url => {
                if (url !== null && url !== desc.displayUrlRaw) {
                    desc.displayUrlRaw = url;
                    desc.displayUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
                    desc.displayError = null;
                }
            }, err => {
                desc.displayError = "Cannot display image: " + (err && err.message ? err.message : err);
            });
        }
    }

    public toggleFilterSettings(){
        this.showFilterSettings = !this.showFilterSettings;
    }

    private loadImages(i: number){
        if (!this.rawImages[i]) return;
        
        const item = this.rawImages[i];

        this.setProgress("Loading " + item.image.imgName, i / this.rawImages.length);

        if (item.coords){
            item.coords.then(_ => this.loadImages(i + 1));
        }else this.loadImages(i + 1);
    }

    public handleImages(files: File[]) {

        files = Array.from(files).filter(f => /\.(jpe?g|png|tiff?|webp|bmp|gif)$/i.test(f.name));
        if (files.length == 0) return;

        var newImages = [];

        for (let i = 0; i < files.length; i++) {

            let file = files[i];

            const name = file.name;
            const type = file.type;

            const url = (window.URL ? URL : webkitURL).createObjectURL(file);
            const imageUrl = url !== null ? this.sanitizer.bypassSecurityTrustResourceUrl(url) : null;

            // Save image
            const image = this.storage.saveImageRaw(file, url);

            const res = this.images.filter(item => item.image.imgName === name);

            // If the image is not present, we add it with the GCP coordinates
            if (res.length === 0) {

                let coord = image.getCoords();
                
                const descr: ImageDescriptor = {
                    image: {
                        gcpName: this.gcp.name,
                        geoX: this.gcp.easting,
                        geoY: this.gcp.northing,
                        geoZ: this.gcp.elevation,
                        imX: 0,
                        imY: 0,
                        imgName: name,
                        extras: []
                    },
                    isTagged: false,
                    pinLocation: null,
                    imageUrl: imageUrl,
                    otherGcps: [],
                    coords: coord,
                    distance: null,
                    displayUrl: null,
                    displayUrlRaw: null,
                    displayError: null
                };

                newImages.push(descr);
                // Otherwise we add the loaded data to the array
            } else {
                res[0].imageUrl = imageUrl;
                res[0].displayUrl = res[0].displayUrlRaw = res[0].displayError = null;
            }

        }

        this.rawImages = this.rawImages.concat(newImages);

        this.loadImages(0);

        Promise.all(this.rawImages.map(item => item.coords)).then(coords => {
            for (let i = 0; i < coords.length; i++) {
                var coord = coords[i];
                var item = this.rawImages[i];

                if (coord) {
                    item.distance = getDistanceFromLatLonInM(this.gcpCoords.y, this.gcpCoords.x, coord.lat, coord.lng);
                    // console.log(item.image.imgName, coord, "Distance: " + item.distance);
                }
            }

            this.filterImages();

            // Notify smart images that pins might have to be refreshed
            window.dispatchEvent(new CustomEvent('smartImagesLayoutChanged'));

            this.setProgress("", 1, true);

        });

    }

    public imagesSelected(event) {

        const files: File[] = event.target.files;

        if (typeof files === 'undefined') {
            return;
        }

        return this.handleImages(files);
    }

    public ok(): void {

        // Suggestions that were not confirmed are not saved: say it before leaving
        const pending = this.images.filter(item => item.isTagged && item.suggested).length;
        if (pending === 0) {
            this.save();
            return;
        }

        const modalRef = this.modalService.open(ConfirmDialogComponent, { ariaLabelledBy: 'modal-basic-title' });
        modalRef.componentInstance.title = "Unconfirmed suggestions";
        modalRef.componentInstance.text = (pending === 1 ? "1 suggestion was not confirmed and will be discarded. " : pending + " suggestions were not confirmed and will be discarded. ") +
            "To keep a suggestion, answer No, click its yellow title to confirm it (it turns green) and save again. Save and discard the unconfirmed ones?";
        modalRef.result.then(result => {
            if (result === 'yes') this.save();
        }, () => {});
    }

    private save(): void {

        // Save in storage
        const tmp = this.storage.imageGcps.filter(img => img.gcpName !== this.gcp.name);

        // Suggestions that were not confirmed (yellow) are not saved
        tmp.push(...this.images.filter(item => item.isTagged && !item.suggested).map(itm => itm.image));

        this.storage.imageGcps = tmp;

        // Then go back
        this.back();
    }

    public back(): void {
        // Go back to GPCs map
        this.router.navigateByUrl('gcps-map');
    }

    public pin(location: CoordsXY, desc: ImageDescriptor): void {
        desc.isTagged = true;
        desc.suggested = false;
        desc.image.imX = location.x;
        desc.image.imY = location.y;
        desc.pinLocation = location;
    }

    // A click on the title of a suggested image accepts the tag where it is, as if tagged by hand:
    // a click on the photo to accept it would move the tag
    public confirm(desc: ImageDescriptor): void {
        if (desc.isTagged && desc.suggested) desc.suggested = false;
    }

    public unpin(desc: ImageDescriptor): void{
        desc.isTagged = false;
        desc.suggested = false;
        desc.image.imX = desc.image.imY = 0;
        desc.pinLocation = null;
        
        const si = this.smartImages.find(si => si.src === desc.displayUrl);
        if (si) si.clearPin();
    }

    public remove(desc: ImageDescriptor) {

        let internal_remove = () => {
            this.images = this.images.filter(item => item.image.imgName !== desc.image.imgName);
            this.rawImages = this.rawImages.filter(item => item.image.imgName !== desc.image.imgName);
            this.storage.removeImage(desc.image.imgName);
            this.loadVisibleImages();

            // Notify smart images that pins might have to be refreshed
            window.dispatchEvent(new CustomEvent('smartImagesLayoutChanged'));
        };

        if (desc.otherGcps.length > 0) {
            if (desc.isTagged){
                this.unpin(desc);
            }else{
                const modalRef = this.modalService.open(ConfirmDialogComponent, { ariaLabelledBy: 'modal-basic-title' });
    
                modalRef.componentInstance.title = "Remove Image";
                modalRef.componentInstance.text = "This image is associated with other GCPs. Do you want to remove it anyway?";
                modalRef.result.then((result) => {
                    if (result === 'yes') internal_remove();
                });
            }
        } else {
            internal_remove();
        }

    }

    public getClass(desc: ImageDescriptor) {

        let cls = null;

        if (desc.imageUrl !== null) {
            if (desc.isTagged) {
                cls = desc.suggested ? 'badge-warning' : 'badge-success';
            } else {
                // if (desc.otherGcps.length !== 0) {
                cls = 'badge-info';
            }
        } else {
            cls = 'badge-warning';
        }

        var obj = {};
        obj[cls] = true;
        return obj;
    }

    public getName(desc: ImageDescriptor) {

        let name = desc.image.imgName;

        // if (desc.otherGcps.length !== 0)
        //     name = name + ' (' + desc.otherGcps.join(', ') + ')';

        if (desc.distance && this.filterByDistance)
            name = name + ' (' + toHumanDistance(desc.distance) + ')';

        if (desc.isTagged && desc.suggested) name = name + ' - suggested';

        return name;
    }

    public detect(desc: ImageDescriptor) {

        this.setProgress("Detecting GCP in " + desc.image.imgName);

        this.detector.detect(desc.image.imgName).then(coords => {

            if (coords != null) {

                this.setProgress("GCP found", 1, true);

                this.pin(coords, desc);
                desc.pinLocation = coords;
            } else {
                this.setProgress("No GCP found", 1, true);
            }

        }, err => {
            console.log(err);
            this.setProgress("Error: " + err, 1, true);
        });
    }

    public async detectImages() {

        this.setProgress("Detecting GCPs in images", 0, false, true);

        const images = this.images.slice((this.page - 1) * this.pageSize, this.page * this.pageSize);

        for (let i = 0; i < images.length; i++) {

            let item = images[i];
            if (item.isTagged) continue;

            let progress = i / images.length;

            if (this.requestedInterrupt) {
                console.warn("Received interrupt signal");
                this.setProgress("Interrupted", progress, true, false);
                this.requestedInterrupt = false;
                return;
            }

            this.setProgress("Detecting GCP in " + item.image.imgName + " (" + (i + 1) + "/" + images.length + ")", progress, false, true);
            let coords = null;
            try {
                coords = await this.detector.detect(item.image.imgName);
            } catch (e) {
                console.warn(e);
            }

            if (coords != null) {

                this.setProgress("GCP found", progress);

                this.pin(coords, item);
                item.pinLocation = coords;
            } else {
                this.setProgress("No GCP found", progress);
            }

        }

        this.setProgress("", 1, true);

    }

    /**
     * Suggests the place of the GCP in every image that passed the distance filter, from the pose the
     * drone wrote in each photo (see exif-projector.ts). Images tagged by hand are kept and used to
     * locate the point; earlier suggestions are computed again, so tagging a couple of photos by hand
     * and running it again improves the rest.
     */
    public async detectByExif() {

        this.exifResult = null;
        this.setProgress("Reading the pose of the photos", 0, false, true);

        // The pose of every loaded image: the distance filter needs it before choosing the images
        const all = this.rawImages.slice();

        for (let i = 0; i < all.length; i++) {
            const name = all[i].image.imgName;
            if (this.exifCameras[name] !== undefined) continue;

            if (this.requestedInterrupt) {
                this.setProgress("Interrupted", i / all.length, true, false);
                this.requestedInterrupt = false;
                return;
            }
            if (i % 10 === 0) this.setProgress("Reading the pose of the photos (" + (i + 1) + "/" + all.length + ")", i / all.length, false, true);

            await this.camera(name);
        }

        // Distance of each image = from the GCP to the place the photo looks at, not to the drone: an
        // oblique photo that sees the point is taken far from it and the old distance filtered it out
        for (const item of all) {
            const cam = this.exifCameras[item.image.imgName];
            if (cam) item.distance = viewDistance(cam);
        }
        this.filterImages();
        const images = this.images.slice();

        // Every image tagged by hand locates the point, also the ones the distance filter hides
        const byHand = all.filter(item => item.isTagged && !item.suggested && this.exifCameras[item.image.imgName]);
        const located = locatePoint(byHand.map(item => ({ cam: this.exifCameras[item.image.imgName], x: item.image.imX, y: item.image.imY })));

        this.exifPoint = located.point;

        let suggested = 0, notVisible = 0, noPose = 0;

        let onBorder = 0;

        for (const item of all) item.centerOffset = null;

        // Images that see the point
        let candidates: { item: ImageDescriptor, cam: Camera, where: { x: number, y: number, offset: number } }[] = [];

        for (const item of images) {
            const cam = this.exifCameras[item.image.imgName];

            if (item.isTagged && !item.suggested) {
                if (cam) item.centerOffset = centerOffset(cam, item.image.imX, item.image.imY);
                continue;
            }
            if (!cam) {
                noPose++;
                continue;
            }

            // A point up to 4 % of the photo side outside the frame is kept, on the border
            const where = project(cam, located.point, EXIF_OUTSIDE * Math.max(cam.width, cam.height));
            if (where) {
                candidates.push({ item, cam, where });
            } else {
                if (item.suggested) this.unpin(item);
                notVisible++;
            }
        }

        // The limit keeps the images where the point falls closer to the center of the photo
        candidates.sort((a, b) => a.where.offset - b.where.offset);
        const overLimit = this.exifMax > 0 ? candidates.splice(this.exifMax) : [];
        for (const { item, where } of overLimit) {
            if (item.suggested) this.unpin(item);
            item.centerOffset = where.offset;
        }
        for (const { item, cam, where } of candidates) {
            this.pin({ x: where.x, y: where.y }, item);
            item.suggested = true;
            item.centerOffset = where.offset;
            suggested++;
            if (where.offset > centerOffset(cam, where.x, where.y) + 1e-9) onBorder++;
        }

        // Visual fine adjustment: the ground around a good tag is searched around each suggestion.
        // The good tag is the most vertical photo tagged by hand; with no photo tagged by hand, the
        // suggestion closest to the center of its photo, and then all the tags fall on the same detail of
        // the ground, the one under that suggestion.
        let visual = '';
        if (this.exifVisual && candidates.length > 0) {
            const hand = byHand.slice().sort((a, b) => this.exifCameras[a.image.imgName].forward[2] - this.exifCameras[b.image.imgName].forward[2])[0];
            const refItem = hand || candidates[0].item;
            const refMap = groundAffine(this.exifCameras[refItem.image.imgName], located.point);
            const targets = hand ? candidates : candidates.slice(1);
            let adjusted = 0, interrupted = false;
            const shifts: number[] = [];

            try {
                if (!refMap) throw new Error('the reference photo does not see the point');
                const ref = await this.detector.visualReference(refItem.image.imgName, refItem.image.imX, refItem.image.imY, refMap.A);
                try {
                    for (let i = 0; i < targets.length; i++) {
                        if (this.requestedInterrupt) {
                            this.requestedInterrupt = false;
                            interrupted = true;
                            break;
                        }
                        const { item, cam } = targets[i];
                        this.setProgress("Visual fine adjustment of " + item.image.imgName + " (" + (i + 1) + "/" + targets.length + ")", i / targets.length, false, true);

                        const map = groundAffine(cam, located.point);
                        const match = map ? await this.detector.visualMatch(ref, item.image.imgName, item.image.imX, item.image.imY, map.A) : null;
                        if (match && match.score >= VISUAL_MIN_SCORE && match.x >= 0 && match.y >= 0 && match.x <= cam.width && match.y <= cam.height) {
                            shifts.push(Math.hypot(match.x - item.image.imX, match.y - item.image.imY));
                            this.pin({ x: match.x, y: match.y }, item);
                            item.suggested = true;
                            adjusted++;
                        }
                    }
                } finally {
                    ref.delete();
                }
                shifts.sort((a, b) => a - b);
                visual = ` Visual fine adjustment against ${refItem.image.imgName} (${hand ? 'tagged by hand' : 'the most centered suggestion: no image is tagged by hand'}): ` +
                    `${adjusted} of ${targets.length} suggestions moved` +
                    (adjusted > 0 ? ` (median ${Math.round(shifts[Math.floor(shifts.length / 2)])} px)` : '') +
                    `, ${targets.length - adjusted} left where the pose puts them (no clear match)` +
                    (interrupted ? ', interrupted' : '') + '. Check every tag: a match can sit on a shadow or a similar detail.';
            } catch (e) {
                console.warn(e);
                visual = ' Visual fine adjustment failed: ' + (e && e.message ? e.message : e) + '.';
            }
        }

        this.filterImages();
        window.dispatchEvent(new CustomEvent('smartImagesLayoutChanged'));

        // What was searched: the button only looks at the images that pass the distance filter
        const searched = this.filterByDistance ?
            `Searched the ${images.length} images that look within ${this.filterDistance} m of "${this.gcp.name}", of ${this.rawImages.length} loaded` :
            `Searched the ${images.length} loaded images`;
        const basis = located.from === 'rays' ? `, using the ${byHand.length} images tagged by hand to locate the point` :
                      located.from === 'one' ? `, using the image tagged by hand to locate the point` : '';
        let result = `${searched}${basis}: ${suggested} suggested (yellow, adjust each one; ordered from the center of the photo to the border), ${notVisible} do not see the point` +
            (onBorder > 0 ? `, ${onBorder} of the suggested are on the border of the photo: the point may be just outside (remove the tag if it is)` : '') +
            (overLimit.length > 0 ? `, ${overLimit.length} more see the point but are over the limit of ${this.exifMax} suggestions` : '') +
            (noPose > 0 ? `, ${noPose} without GPS/gimbal data` : '') + '.' + visual;
        if (suggested === 0) {
            result += this.filterByDistance ?
                ' No photo of this place among them: load the photos of this area with the file box above (opening a GCP file loads only the photos it lists), or raise the distance filter.' :
                ' No photo of this place among them: load the photos of this area with the file box above.';
        }
        this.exifResult = result;

        this.setProgress("", 1, true);
    }

    public requestedInterrupt: boolean = false;

    public interrupt() {
        this.requestedInterrupt = true;
        this.loadingMessage = "Interrupting...";
        this.allowProgressClose = false;
    }

    private setProgress(text: string, progress: number = 0, close: boolean = false, allowClose: boolean = false) {

        
        setTimeout(() => {
            this.allowProgressClose = allowClose;
            this.loadingProgress = progress;
            this.loadingMessage = text;
            this.isLoading = true;
            this.appRef.tick();
        }, 1);


        if (close) {
            setTimeout(() => {
                this.isLoading = false;
                this.loadingProgress = 0;
                this.loadingMessage = null;
            }, 250);
        }
    }

}

class ImageDescriptor {
    public image: ImageGcp;
    public isTagged: boolean;
    public pinLocation: CoordsXY;
    public imageUrl: SafeResourceUrl;
    public displayUrl: SafeResourceUrl;
    public displayUrlRaw: string;
    public displayError: string;
    public otherGcps: string[];
    public coords: Promise<GPSCoords>;
    public distance: number;
    public suggested?: boolean;
    // Where the GCP falls in the photo: 0 = center, 1 = corner (null = not known)
    public centerOffset?: number;
    // How to draw the photo with north up (see northUp in exif-projector.ts)
    public north?: number[];
}

