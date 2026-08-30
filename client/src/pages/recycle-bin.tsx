import { TitleBar } from '@/components/ui/title-bar';
import { RecycleBinList } from '@/components/recycle-bin/recycle-bin-list';

export function RecycleBin() {
  return (
    <div>
      {/* #284: the only page in its cluster (/matches, /print) with no
          TitleBar and no real <h1> — the sidebar's "Tally" was the page's
          only heading. */}
      <h1 className="mb-4"><TitleBar>Recycle Bin</TitleBar></h1>
      <RecycleBinList />
    </div>
  );
}
