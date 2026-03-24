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
  product?: Product;
  createdAt: string;
}

export interface Product {
  id: number;
  barcode: string;
  name: string;
  brand: string;
  category: string;
  imageUrl: string | null;
  retailPrice: number | null;
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
