import { useEffect, useState } from 'react';

/**
 * Whether this machine has a camera at all.
 *
 * The question a scan control needs answered is not "is this a desktop" — an
 * iPad in landscape wears the same sidebar and has a perfectly good camera, and
 * a laptop can scan a label you hold up to it. Guessing from width is the
 * mistake the chrome rule already had to unlearn; this asks the device instead.
 *
 * enumerateDevices() reports video inputs without prompting for permission
 * (labels come back blank until granted, which is fine — only the count
 * matters). Where the API is missing entirely, assume a camera rather than
 * hiding a working feature.
 *
 * Starts TRUE deliberately. Most devices that run this app have a camera, so
 * assuming yes means no layout shift for the common case; the row disappears
 * once, quickly, only on the machines that genuinely have none. Starting false
 * would flash a missing row onto every phone.
 */
export function useHasCamera(): boolean {
  const [has, setHas] = useState(true);

  useEffect(() => {
    let alive = true;
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media?.enumerateDevices) return;

    media.enumerateDevices()
      .then((devices) => {
        if (alive) setHas(devices.some((d) => d.kind === 'videoinput'));
      })
      // A refusal to enumerate is not evidence of absence — keep the feature.
      .catch(() => { if (alive) setHas(true); });

    return () => { alive = false; };
  }, []);

  return has;
}
