import { Routes, Route, Navigate } from 'react-router-dom';
import { RootLayout } from '@/components/layout/root-layout';
import { Login } from '@/pages/login';
import { OAuthCallback } from '@/pages/oauth-callback';
import { QrRedirect } from '@/pages/qr-redirect';
import { ShareView } from '@/pages/share-view';

// Lazy load pages to keep initial bundle small
import { Home } from '@/pages/home';
import { PropertyDetail } from '@/pages/property-detail';
import { AreaDetail } from '@/pages/area-detail';
import { ContainerDetail } from '@/pages/container-detail';
import { ItemDetail } from '@/pages/item-detail';
import { Scan } from '@/pages/scan';
import { PutDown } from '@/pages/put-down';
import { Capture } from '@/pages/capture';
import { Reports } from '@/pages/reports';
import { PrintQueuePage } from '@/pages/print-queue';
import { SearchPage } from '@/pages/search';
import { SettingsPage } from '@/pages/settings';
import { NotificationListPage } from '@/pages/notifications';
import { RecycleBin } from '@/pages/recycle-bin';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/oauth/callback" element={<OAuthCallback />} />
      <Route path="/s/:code" element={<QrRedirect />} />
      <Route path="/share/:token" element={<ShareView />} />
      <Route element={<RootLayout />}>
        <Route index element={<Home />} />
        {/* The Inventory tab was a strict subset of Home; the route survives
            as a redirect so old links and muscle memory keep working. */}
        <Route path="/inventory" element={<Navigate to="/" replace />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/property/:propertyId" element={<PropertyDetail />} />
        <Route path="/area/:areaId" element={<AreaDetail />} />
        <Route path="/container/:containerId" element={<ContainerDetail />} />
        <Route path="/item/:itemId" element={<ItemDetail />} />
        <Route path="/scan" element={<Scan />} />
        <Route path="/move" element={<PutDown />} />
        <Route path="/capture" element={<Capture />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/print" element={<PrintQueuePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/notifications" element={<NotificationListPage />} />
        <Route path="/recycle-bin" element={<RecycleBin />} />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
