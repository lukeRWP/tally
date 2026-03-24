import { RecycleBinList } from '@/components/recycle-bin/recycle-bin-list';

export function RecycleBin() {
  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Recycle Bin</h2>
      <RecycleBinList />
    </div>
  );
}
