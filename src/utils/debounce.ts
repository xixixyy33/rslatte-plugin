/** 简易 debounce（基于 window.setTimeout） */
export function debounce<T extends (...args: any[]) => void>(fn: T, waitMs: number): T {
  let timer: number | null = null;
  return function (this: any, ...args: any[]) {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, waitMs);
  } as T;
}
