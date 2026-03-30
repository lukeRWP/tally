export interface Property {
  id: number;
  name: string;
  address: string | null;
  description: string | null;
  qrCode: string;
  role: 'owner' | 'editor' | 'viewer';
  areaCount: number;
  containerCount: number;
  itemCount: number;
  createdAt: string;
}

export interface Area {
  id: number;
  propertyId: number;
  name: string;
  description: string | null;
  qrCode: string;
  containerCount: number;
  itemCount: number;
}

export interface Container {
  id: number;
  areaId: number;
  parentContainerId: number | null;
  name: string;
  type: string;
  description: string | null;
  qrCode: string;
  nestedContainerCount: number;
  itemCount: number;
  breadcrumb: BreadcrumbItem[];
}

export interface Item {
  id: number;
  containerId: number;
  productId: number | null;
  name: string;
  description: string | null;
  quantity: number;
  purchasePrice: number | null;
  currentValue: number | null;
  condition: 'new' | 'good' | 'fair' | 'poor';
  qrCode: string;
  status: 'active' | 'removed' | 'lent';
  createdAt: string;
  breadcrumb?: BreadcrumbItem[];
  // Product data (flat fields from API, joined from products table)
  productName?: string | null;
  productBrand?: string | null;
  productImageUrl?: string | null;
  productDescription?: string | null;
  productCategory?: string | null;
  productBarcode?: string | null;
  productRetailPrice?: number | null;
  productRetailLinks?: { retailer: string; url: string; price?: number }[] | null;
  productSpecs?: Record<string, unknown> | null;
  productDataSource?: string | null;
}

export interface BreadcrumbItem {
  id: number;
  name: string;
  type: 'property' | 'area' | 'container';
}

export interface PropertyMember {
  id: number;
  userId: number;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'owner' | 'editor' | 'viewer';
}
