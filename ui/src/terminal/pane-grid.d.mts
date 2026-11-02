export interface PaneSlot {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function paneGrid(n: number): PaneSlot[];
