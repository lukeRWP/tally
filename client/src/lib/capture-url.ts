/**
 * Where you are standing is almost always where the new thing goes, so the
 * create action carries the current page into the flow: a container pre-pins as
 * the destination, an area pre-selects the picker's area so the bin list is one
 * tap away. Standing nowhere in particular just opens the flow.
 *
 * Shared by the bottom nav and the sidebar. It lived inside bottom-nav until
 * the sidebar gained a create action, and two copies of a rule like this drift
 * — the sidebar button would quietly stop pre-pinning while the phone one
 * still did, and nothing would fail.
 */
export function buildCaptureUrl(pathname: string): string {
  const container = pathname.match(/^\/container\/(\d+)/);
  if (container) return `/capture?containerId=${container[1]}`;

  const area = pathname.match(/^\/area\/(\d+)/);
  if (area) return `/capture?areaId=${area[1]}`;

  const property = pathname.match(/^\/property\/(\d+)/);
  if (property) return `/capture?propertyId=${property[1]}`;

  return '/capture';
}
