/// <reference types="vite/client" />

// UTIF.js ships no types. Declare the minimal surface our TIFF renderer uses:
// decode the container into IFDs, decode each IFD's pixels in place, then read it
// back as RGBA. See https://github.com/photopea/UTIF.js.
declare module "utif" {
  interface IFD {
    width?: number;
    height?: number;
    [key: string]: unknown;
  }
  const UTIF: {
    decode(buf: ArrayBuffer | Uint8Array): IFD[];
    decodeImage(buf: ArrayBuffer | Uint8Array, ifd: IFD): void;
    toRGBA8(ifd: IFD): Uint8Array;
  };
  export default UTIF;
}
