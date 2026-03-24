export interface ItemFile {
  id: number;
  itemId: number;
  fileType: 'receipt' | 'warranty' | 'manual' | 'photo' | 'other';
  fileKey: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedBy: number;
  createdAt: string;
  url?: string;
}

export interface ConditionSnapshot {
  id: number;
  itemId: number;
  condition: 'new' | 'good' | 'fair' | 'poor';
  photoKey: string;
  notes: string | null;
  recordedBy: number;
  recordedByName?: string;
  createdAt: string;
  photoUrl?: string;
}
