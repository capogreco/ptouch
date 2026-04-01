// Brother P-touch model definitions
// Add new models by adding entries to the MODELS map below.

export interface PtouchModel {
  /** Display name, e.g. "PT-P710BT" */
  name: string;
  /** USB vendor:product ID, e.g. "04f9:20af" */
  usbId: string;
  /** Maximum tape width in mm */
  maxTapeMm: number;
  /** Number of print head pins */
  headPins: number;
  /** Bytes per raster line (headPins / 8) */
  rasterBytes: number;
  /** Print resolution in DPI */
  dpi: number;
  /** Supported tape widths in mm */
  tapeWidths: number[];
  /** Supported connection types */
  connections: ("usb" | "bluetooth" | "wifi")[];
  /** Optional feature flags */
  features: {
    halfCut?: boolean;
    highRes?: boolean;
    chainPrint?: boolean;
  };
}

/** Map of tape width (mm) to printable pixel count for 128-pin (24mm max) heads */
export const TAPE_PIXELS_128: Record<number, number> = {
  6: 32,
  9: 52,
  12: 76,
  18: 106,
  24: 128,
};

/** Map of tape width (mm) to printable pixel count for 256-pin (36mm max) heads */
export const TAPE_PIXELS_256: Record<number, number> = {
  ...TAPE_PIXELS_128,
  36: 256,
};

/** Get printable pixel count for a tape width on a given model */
export function tapePixels(model: PtouchModel, tapeWidthMm: number): number | undefined {
  const map = model.headPins <= 128 ? TAPE_PIXELS_128 : TAPE_PIXELS_256;
  return map[tapeWidthMm];
}

/**
 * Model registry keyed by USB product ID (vendor:product).
 * To add support for a new model, add an entry here.
 */
export const MODELS: Record<string, PtouchModel> = {
  "04f9:20af": {
    name: "PT-P710BT",
    usbId: "04f9:20af",
    maxTapeMm: 24,
    headPins: 128,
    rasterBytes: 16,
    dpi: 180,
    tapeWidths: [3.5, 6, 9, 12, 18, 24],
    connections: ["usb", "bluetooth"],
    features: {},
  },

  "04f9:2061": {
    name: "PT-P750W",
    usbId: "04f9:2061",
    maxTapeMm: 24,
    headPins: 128,
    rasterBytes: 16,
    dpi: 180,
    tapeWidths: [3.5, 6, 9, 12, 18, 24],
    connections: ["usb", "wifi"],
    features: { halfCut: true },
  },

  "04f9:2062": {
    name: "PT-E550W",
    usbId: "04f9:2062",
    maxTapeMm: 24,
    headPins: 128,
    rasterBytes: 16,
    dpi: 180,
    tapeWidths: [3.5, 6, 9, 12, 18, 24],
    connections: ["usb", "wifi"],
    features: { halfCut: true },
  },

  "04f9:20a7": {
    name: "PT-P300BT",
    usbId: "04f9:20a7",
    maxTapeMm: 12,
    headPins: 128,
    rasterBytes: 16,
    dpi: 180,
    tapeWidths: [3.5, 6, 9, 12],
    connections: ["bluetooth"],
    features: {},
  },

  "04f9:20c0": {
    name: "PT-P900W",
    usbId: "04f9:20c0",
    maxTapeMm: 36,
    headPins: 256,
    rasterBytes: 32,
    dpi: 360,
    tapeWidths: [3.5, 6, 9, 12, 18, 24, 36],
    connections: ["usb", "wifi"],
    features: { halfCut: true, highRes: true },
  },

  "04f9:20c1": {
    name: "PT-P950NW",
    usbId: "04f9:20c1",
    maxTapeMm: 36,
    headPins: 256,
    rasterBytes: 32,
    dpi: 360,
    tapeWidths: [3.5, 6, 9, 12, 18, 24, 36],
    connections: ["usb", "wifi"],
    features: { halfCut: true, highRes: true },
  },
};

/** Look up a model by its USB product ID string ("04f9:20af") */
export function findModel(usbId: string): PtouchModel | undefined {
  return MODELS[usbId.toLowerCase()];
}

/** List all supported model names */
export function supportedModels(): PtouchModel[] {
  return Object.values(MODELS);
}
