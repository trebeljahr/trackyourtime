export function isPortFree(port: number): Promise<boolean>;
export function pickHmrPort(
  file: string,
  options?: { isFree?: (port: number) => Promise<boolean>; random?: () => number },
): Promise<number>;
