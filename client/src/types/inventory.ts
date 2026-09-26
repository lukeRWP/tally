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
  containerCount: number;
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
  /** True when currentValue came from photo identification rather than the user. */
  currentValueIsEstimate: boolean;
  condition: 'new' | 'good' | 'fair' | 'poor';
  /**
   * A small derivative for list rows. Absent until one has been generated —
   * callers fall back to photoUrl, which is the full-size original.
   */
  photoThumbUrl?: string;
  /** Whether the thing itself is here, or only its packaging / spares. */
  completeness: 'complete' | 'box_only' | 'accessories_only';
  qrCode: string;
  status: 'active' | 'removed' | 'lent';
  createdAt: string;
  breadcrumb?: BreadcrumbItem[];
  /** Present on search results: where the item lives, for the result card. */
  location?: { property: string | null; area: string | null; container: string | null };
  // Product data (flat fields from API, joined from products table)
  productName?: string | null;
  productBrand?: string | null;
  productImageUrl?: string | null;
  /** Newest uploaded photo (presigned). Preferred over the catalogue image. */
  photoUrl?: string | null;
  productDescription?: string | null;
  productCategory?: string | null;
  productBarcode?: string | null;
  productRetailPrice?: number | null;
  productRetailLinks?: { retailer: string; url: string; price?: number }[] | null;
  productSpecs?: Record<string, unknown> | null;
  productDataSource?: string | null;
  /** A shorter name worth offering, or null when the current one is fine. */
  suggestedName?: string | null;
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

/**
 * A pending invite through pwiam (plan 2026-09-26-property-invites.md). No
 * email and no url — the invitee is keyed by their pwiam `sub`, minted
 * server-side, and the join link is shown exactly once, at creation
 * (`CreatedPropertyInvite` below), never again.
 */
export interface PropertyInvite {
  id: number;
  propertyId: number;
  role: 'editor' | 'viewer';
  displayName: string;
  invitedBy: number;
  expiresAt: string;
  createdAt: string;
}

/** The one response that carries the join url — its only appearance. */
export interface CreatedPropertyInvite {
  invite: PropertyInvite;
  url: string;
}
