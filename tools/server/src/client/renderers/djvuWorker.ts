// Off-main-thread DjVu decoding. The vendored DjVu.js (vendor/djvu.js) doubles as its own Web
// Worker script (it detects worker context internally); `new DjVu.Worker()` spins that worker from
// an inline blob. We drive ONE worker + ONE open document at a time (one viewer is open at a time),
// decoding pages lazily on demand so the main thread never blocks on JB2/IW44 decompression — which
// is what froze annotation while a big scan decoded. The library bundle itself is injected once as a
// classic <script> so the `DjVu.Worker` class is available on the main thread.
import djvuScriptUrl from "../vendor/djvu.js?url";

declare global {
  interface Window { DjVu?: any }
}

/** One OCR text zone — absolute pixels in the page's native space (top-left origin). */
export interface Zone { x: number; y: number; width: number; height: number; text: string }
/** A decoded page: pixels (paint to a canvas), OCR zones (may be empty), native pixel size. */
export interface DecodedPage { image: ImageData; zones: Zone[]; w: number; h: number }

let libLoading: Promise<any> | null = null;
/** Inject the vendored bundle once; resolve with the global `DjVu` namespace (for `DjVu.Worker`). */
function loadDjVu(): Promise<any> {
  if (window.DjVu) return Promise.resolve(window.DjVu);
  libLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = djvuScriptUrl;
    s.onload = () => (window.DjVu ? resolve(window.DjVu) : reject(new Error("DjVu failed to load")));
    s.onerror = () => reject(new Error("could not load djvu.js"));
    document.head.appendChild(s);
  });
  return libLoading;
}

let worker: any = null; // the singleton DjVu.Worker (kept alive across viewers, like pdf.js's worker)
let curKey: string | null = null; // node.path of the currently open document
let opening: Promise<number> | null = null; // resolves to the page count of the open document
const cache = new Map<number, DecodedPage>(); // LRU (by re-insertion) of decoded pages — bounds memory
const inflight = new Map<number, Promise<DecodedPage>>();
const CACHE_CAP = 6; // few full pages kept; scans are huge (a native page can be ~tens of MB)
const MAX_RASTER_W = 1500; // cap stored pixels: a scan's native width is overkill for a ~1000px display
                           // (and at full native res the in-memory ImageData crashes the tab)

/** Open a DjVu document in the worker (re-creating only when the file changes) and resolve its page
 *  count. The buffer is transferred to the worker. */
export async function openDjvu(buf: ArrayBuffer, key: string): Promise<number> {
  const DjVu = await loadDjVu();
  worker ??= new DjVu.Worker(); // inline-blob worker; no separate script URL needed
  if (key !== curKey) {
    curKey = key;
    cache.clear();
    inflight.clear();
    opening = (async () => {
      await worker.createDocument(buf);
      return Number(await worker.doc.getPagesQuantity().run()) || 0;
    })();
  }
  return opening!;
}

/** Resize a (large) ImageData to `targetW` wide, preserving aspect → a smaller ImageData. The
 *  browser does the resampling in `createImageBitmap` (off the main thread); the full-size source is
 *  then released. Keeps memory bounded without changing coordinates (native size is tracked apart). */
async function downscale(full: ImageData, targetW: number): Promise<ImageData> {
  const targetH = Math.max(1, Math.round((full.height * targetW) / full.width));
  const bmp = await createImageBitmap(full, { resizeWidth: targetW, resizeHeight: targetH, resizeQuality: "medium" });
  const cnv = document.createElement("canvas");
  cnv.width = targetW;
  cnv.height = targetH;
  const cx = cnv.getContext("2d")!;
  cx.drawImage(bmp, 0, 0);
  bmp.close();
  return cx.getImageData(0, 0, targetW, targetH);
}

/** Decode one page (1-based) off the main thread: image + OCR zones + native size, in a single
 *  batched worker round-trip. Memoized (LRU) so re-scroll/zoom doesn't re-decode. */
export function decodeDjvuPage(n: number): Promise<DecodedPage> {
  const hit = cache.get(n);
  if (hit) { cache.delete(n); cache.set(n, hit); return Promise.resolve(hit); } // LRU touch
  const pending = inflight.get(n);
  if (pending) return pending;
  const p = (async () => {
    const [full, zones, w, h] = await worker.run(
      worker.doc.getPage(n).getImageData(),
      worker.doc.getPage(n).getNormalizedTextZones(),
      worker.doc.getPage(n).getWidth(),
      worker.doc.getPage(n).getHeight(),
    );
    const nativeW = Number(w) || full.width, nativeH = Number(h) || full.height;
    // Downscale to a display-adequate raster (the native scan is huge); coordinates stay in NATIVE
    // px (zones + region selectors), so the smaller canvas is purely a sharpness/memory trade.
    const image = nativeW > MAX_RASTER_W ? await downscale(full, MAX_RASTER_W) : full;
    const dp: DecodedPage = { image, zones: Array.isArray(zones) ? zones : [], w: nativeW, h: nativeH };
    inflight.delete(n);
    cache.set(n, dp);
    while (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value as number); // evict oldest
    return dp;
  })();
  inflight.set(n, p);
  return p;
}
