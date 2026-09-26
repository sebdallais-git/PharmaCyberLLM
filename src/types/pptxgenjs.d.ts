// pptxgenjs ships its own declaration file (node_modules/pptxgenjs/types/index.d.ts),
// but it cannot be resolved correctly under this project's Node16 module
// resolution: the package's flat `"types"` export condition (not split per
// `import`/`require` condition) resolves to a self-referential module type
// with no construct signature ("This expression is not constructable"). The
// runtime export is unaffected — `module.exports = PptxGenJS` in
// dist/pptxgen.cjs.js is a plain CJS default export and `new PptxGenJS()`
// works fine at runtime; only the upstream .d.ts is unresolvable here.
//
// This ambient module declares just the surface render-pptx.ts uses. Widen
// it if a future renderer needs more of the API.
declare module "pptxgenjs" {
  export type PptxLayout = "LAYOUT_4x3" | "LAYOUT_16x9" | "LAYOUT_16x10" | "LAYOUT_WIDE";

  export interface TextBoxOptions {
    x: number;
    y: number;
    w: number;
    h: number;
    fontSize: number;
    bold?: boolean;
  }

  export interface TableOptions {
    x: number;
    y: number;
    w: number;
    fontSize: number;
  }

  export interface Slide {
    addText(text: string, options: TextBoxOptions): Slide;
    addTable(rows: string[][], options: TableOptions): Slide;
  }

  export type PptxOutputType = "arraybuffer" | "base64" | "binarystring" | "blob" | "nodebuffer" | "uint8array";

  export default class PptxGenJS {
    layout: PptxLayout;
    addSlide(): Slide;
    write(options: { outputType: PptxOutputType }): Promise<unknown>;
  }
}
