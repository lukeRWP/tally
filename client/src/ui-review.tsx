/* Local-only visual review harness: runs the REAL app with the API stubbed,
   so every screen can be rendered and eyeballed without the docker stack.
   Route comes from ?route=/container/1 ; theme from ?theme=dark  */
import ReactDOM from 'react-dom/client';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import './globals.css';

const P = new URLSearchParams(location.search);
if (P.get('theme') === 'dark') document.documentElement.classList.add('dark');
else document.documentElement.classList.add('light');

// ---- fixtures -------------------------------------------------------------
const user = { id: 1, displayName: 'Luke Turner', email: 'luke@example.com', role: 'owner' };
const property = { id: 1, name: "Luke's Apartment", qrCode: 'TLY-P-A1B2C3D4', role: 'owner',
  areaCount: 4, containerCount: 12, itemCount: 132, address: '123 Example St', description: '' };
const areas = [
  { id: 1, name: 'Coat Closet', qrCode: 'TLY-A-11112222', propertyId: 1, containerCount: 3, itemCount: 21 },
  { id: 2, name: 'Garage', qrCode: 'TLY-A-33334444', propertyId: 1, containerCount: 6, itemCount: 74 },
];
const containers = [
  { id: 1, name: 'Tote', type: 'Drawer', qrCode: 'TLY-C-DC65C4EC', areaId: 1, nestedContainerCount: 0, itemCount: 1, breadcrumb: [{ id: 1, name: "Luke's Apartment", type: 'property' }, { id: 1, name: 'Coat Closet', type: 'area' }], propertyId: 1, propertyName: "Luke's Apartment", areaName: 'Coat Closet' },
  { id: 2, name: 'Holiday Decorations Bin', type: 'Plastic Storage Tote', qrCode: 'TLY-C-7BDFD878', areaId: 1, nestedContainerCount: 2, itemCount: 9, breadcrumb: [], propertyId: 1 },
];
const items = [
  { id: 1, name: 'SCHNEIDER Clear Vinyl Exam Gloves, 100ct', qrCode: 'TLY-I-59C8985A', condition: 'good', status: 'active', quantity: 100, containerId: 1, purchasePrice: 12.99, breadcrumb: [{ id: 1, name: "Luke's Apartment", type: 'property' }, { id: 1, name: 'Coat Closet', type: 'area' }, { id: 1, name: 'Tote', type: 'container' }], location: { property: "Luke's Apartment", area: 'Coat Closet', container: 'Tote' } },
  { id: 2, name: 'Cordless Drill', qrCode: 'TLY-I-3A9F2C11', condition: 'new', status: 'lent', quantity: 1, containerId: 1, breadcrumb: [], location: { property: "Luke's Apartment", area: 'Garage', container: 'Bin 4' } },
];
const loans = [
  { id: 1, itemId: 2, itemName: 'Cordless Drill', lentTo: 'Sarah', dueAt: '2026-07-29T00:00:00.000Z', lentAt: '2026-07-01T00:00:00.000Z', returnedAt: null },
  { id: 2, itemId: 1, itemName: 'Cooler', lentTo: 'Mike', dueAt: '2026-08-12T00:00:00.000Z', lentAt: '2026-08-01T00:00:00.000Z', returnedAt: null },
];
const activity = [
  { id: 1, entityType: 'item', entityId: 1, action: 'created', createdAt: new Date(Date.now() - 3.6e6).toISOString(), userName: 'Luke', entityName: 'Exam Gloves' },
  { id: 2, entityType: 'container', entityId: 1, action: 'updated', createdAt: new Date(Date.now() - 9e7).toISOString(), userName: 'Luke', entityName: 'Tote' },
];
const tags = [{ id: 1, name: 'Supplies', color: '#e0561f', propertyId: 1 }, { id: 2, name: 'PPE', color: '#3b82f6', propertyId: 1 }];
const printers = [{ id: 1, name: 'Garage Pi', propertyId: 1, loadedMedia: 'medium', lastSeenAt: new Date().toISOString(), printerState: 'idle', printerStateReasons: [] }];
const jobs = [
  { id: 5, status: 'queued', preset: 'medium', entityType: 'container', entityIds: [1], createdAt: new Date().toISOString(), attempts: 0 },
  { id: 4, status: 'done', preset: 'large', entityType: 'area', entityIds: [1], createdAt: new Date(Date.now() - 8.6e7).toISOString(), attempts: 1 },
];

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

// Exactly the envelope sharing.service.js builds (nested + flat child arrays).
const shareEnvelopes: Record<string, unknown> = {
  prop: { type: 'property',
    property: { id: 1, name: "Luke's Apartment", address: '123 Example St', description: 'Main residence' },
    areas: [{ id: 1, name: 'Coat Closet' }, { id: 2, name: 'Garage' }],
    containers: [
      { id: 1, areaId: 1, parentContainerId: null, name: 'Tote', type: 'Drawer' },
      { id: 2, areaId: 1, parentContainerId: 1, name: 'Small Parts Box', type: 'Box' },
      { id: 3, areaId: 2, parentContainerId: null, name: 'Bin 4', type: 'Bin' },
    ],
    items: [
      { id: 1, containerId: 1, name: 'Exam Gloves', quantity: 100, condition: 'good' },
      { id: 2, containerId: 2, name: 'M3 Screws', quantity: 200, condition: 'new' },
      { id: 3, containerId: 3, name: 'Cordless Drill', quantity: 1, condition: 'new' },
    ] },
  area: { type: 'area',
    area: { id: 1, name: 'Coat Closet', description: 'By the front door' },
    containers: [
      { id: 1, areaId: 1, parentContainerId: null, name: 'Tote', type: 'Drawer' },
      { id: 2, areaId: 1, parentContainerId: 1, name: 'Small Parts Box', type: 'Box' },
    ],
    items: [{ id: 1, containerId: 1, name: 'Exam Gloves', quantity: 100, condition: 'good' }] },
  cont: { type: 'container',
    container: { id: 1, name: 'Tote', type: 'Drawer', description: 'Linen closet tote',
      breadcrumb: [{ id: 1, name: "Luke's Apartment", type: 'property' }, { id: 1, name: 'Coat Closet', type: 'area' }] },
    nestedContainers: [{ id: 2, name: 'Small Parts Box', type: 'Box' }],
    items: [{ id: 1, name: 'Exam Gloves', quantity: 100, condition: 'good', status: 'active' }] },
  item: { type: 'item',
    item: { id: 1, name: 'SCHNEIDER Clear Vinyl Exam Gloves, 100ct', quantity: 100, condition: 'good',
      status: 'active', purchasePrice: 12.99, qrCode: 'TLY-I-59C8985A',
      productName: 'Clear Vinyl Exam Gloves', productBrand: 'SCHNEIDER', productImageUrl: '',
      breadcrumb: [{ id: 1, name: "Luke's Apartment", type: 'property' }, { id: 1, name: 'Coat Closet', type: 'area' }, { id: 1, name: 'Tote', type: 'container' }] },
    files: [], dates: [{ id: 1, dateType: 'Expiry', dateValue: '2027-03-01', notes: null }], conditionSnapshots: [] },
};

const routes: [RegExp, () => unknown][] = [
  [/\/api\/sharing\/_x_\/view\//, () => ({ entity: shareEnvelopes[new URLSearchParams(location.search).get('share') || 'cont'] })],
  [/\/api\/auth\/_x_\/session/, () => ({ user })],
  [/\/api\/properties\/_x_\/list/, () => ({ properties: [property] })],
  [/\/api\/properties\/_x_\/\d+/, () => ({ property })],
  [/\/api\/areas\/_x_\/property\/\d+/, () => ({ areas })],
  [/\/api\/containers\/_x_\/area\/\d+/, () => ({ containers })],
  [/\/api\/containers\/_x_\/\d+\/children/, () => ({ containers: [containers[1]] })],
  [/\/api\/containers\/_x_\/\d+/, () => ({ container: containers[0] })],
  [/\/api\/items\/_x_\/container\/\d+/, () => ({ items })],
  [/\/api\/items\/_x_\/search/, () => ({ items })],
  [/\/api\/items\/_x_\/\d+/, () => ({ item: items[0] })],
  [/\/api\/audit\/_x_\/recent/, () => ({ entries: activity })],
  [/\/api\/lending\/_x_\/active/, () => ({ active: loans })],
  [/\/api\/lending\/_x_\/overdue/, () => ({ overdue: [loans[0]] })],
  [/\/api\/lending\/_x_\/item\/\d+\/active/, () => null],
  [/\/api\/lending\/_x_\/item\/\d+/, () => []],
  [/\/api\/notifications\/_x_\/unread-count/, () => ({ count: 3 })],
  [/\/api\/notifications\/_x_\/list/, () => ({ notifications: [] })],
  [/\/api\/notifications\/_x_\/preferences/, () => ({ preferences: {} })],
  [/\/api\/tags\/_x_\/property\/\d+/, () => ({ tags })],
  [/\/api\/tags\/_x_\/entity\//, () => ({ tags: [tags[0]] })],
  [/\/api\/print\/_x_\/agents/, () => printers],
  [/\/api\/print\/_x_\/jobs/, () => jobs],
  [/\/api\/files\/_x_\/item\/\d+/, () => []],
  [/\/api\/conditions\/_x_\/item\/\d+/, () => []],
  [/\/api\/sharing\/_x_\/my-links/, () => ({ links: [] })],
  [/\/api\/dates\/_x_\//, () => ({ dates: [] })],
  [/\/api\/accessories\/_x_\//, () => ({ accessories: [] })],
];

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.includes('/api/')) return realFetch(input as RequestInfo, init);
  for (const [re, fn] of routes) if (re.test(url)) return ok(fn());
  return ok({});
};

// ?carry=1 seeds the carry banner so the move flow can be eyeballed
if (P.get('carry')) {
  const n = Number(P.get('carry')) || 1;
  import('@/store/carry-store').then(({ useCarryStore }) => {
    useCarryStore.getState().pickUp(
      Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        name: i === 0 ? 'Cordless Drill' : `Item ${i + 1}`,
        fromContainerId: 99,
        fromContainerName: 'Bin 4',
      })),
    );
  });
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

async function boot() {
  const [{ App }, { Toaster }] = await Promise.all([import('@/App'), import('@/components/ui/toast')]);
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[P.get('route') || '/']}>
        <App />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
boot();
