export interface PaneSlot {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function paneGrid(n: number): PaneSlot[];

export type PaneNode =
  | { key: string; w: number; dir?: undefined; kids?: undefined }
  | { dir: "row" | "col"; w: number; kids: PaneNode[]; key?: undefined };

export interface PaneTile extends PaneSlot {
  key: string;
}

export interface PaneDivider {
  path: number[];
  index: number;
  dir: "row" | "col";
  x: number;
  y: number;
  len: number;
  box: PaneSlot;
}

export type DropZone = "center" | "left" | "right" | "top" | "bottom";

export const MAIN_KEY: string;
export function defaultLayout(keys: string[]): PaneNode | null;
export function layoutRects(root: PaneNode | null): { tiles: PaneTile[]; dividers: PaneDivider[] };
export function nodeAt(root: PaneNode | null, path: number[]): PaneNode | null;
export function removeTile(root: PaneNode | null, key: string): PaneNode | null;
/** 树里是否已有某键的叶子（改名前查 stale 叶用——重复键 syncLayout 永不剪，会随开格繁殖）。 */
export function treeHasKey(root: PaneNode | null, key: string): boolean;
export function swapTiles(root: PaneNode, a: string, b: string): PaneNode;
export function insertBeside(root: PaneNode, target: string, side: Exclude<DropZone, "center">, key: string): PaneNode;
export function moveTile(root: PaneNode, src: string, dst: string, zone: DropZone): PaneNode;
export function syncLayout(root: PaneNode | null, keys: string[], aspect?: number): PaneNode | null;
export function resizeAt(root: PaneNode, path: number[], index: number, frac: number, minA?: number, minB?: number): PaneNode;
export function equalizeAt(root: PaneNode, path: number[]): PaneNode;
export function minExtent(node: PaneNode, axis: "x" | "y", minW: number, minH: number): number;
export function dropZone(rx: number, ry: number): DropZone;
