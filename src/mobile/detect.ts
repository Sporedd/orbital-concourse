/**
 * Mobile detection. The only file of src/mobile that main.ts imports statically: it is tiny,
 * has no side effects and creates nothing. Everything else of the mobile layer is behind the
 * one dynamic `import('@/mobile')` in main.ts, which runs only when this says yes, so a
 * desktop browser never fetches the module, never gets html.mobile and never gets a listener.
 *
 *   ?mobile=1   force the mobile layer on (desktop testing)
 *   ?mobile=0   force it off (a phone gets the plain desktop build)
 *   otherwise   a coarse primary pointer AND touch points (a touch laptop's primary pointer is
 *               the fine touchpad/mouse, so it stays desktop)
 */

export interface DeviceProbe {
  /** location.search */
  search: string;
  /** navigator.maxTouchPoints */
  maxTouchPoints: number;
  /** matchMedia('(pointer: coarse)').matches: the primary pointer is a finger. */
  coarse: boolean;
}

/** Reads the live browser (safe without window/navigator: tests, workers). */
export function probeDevice(): DeviceProbe {
  const mm = (q: string): boolean => {
    try {
      return typeof matchMedia === 'function' && matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  return {
    search: typeof location !== 'undefined' ? location.search : '',
    maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0,
    coarse: mm('(pointer: coarse)'),
  };
}

export function isMobileDevice(probe: DeviceProbe = probeDevice()): boolean {
  let flag: string | null = null;
  try {
    flag = new URLSearchParams(probe.search).get('mobile');
  } catch {
    flag = null;
  }
  if (flag === '1') return true;
  if (flag === '0') return false;
  return probe.coarse && probe.maxTouchPoints > 0;
}
