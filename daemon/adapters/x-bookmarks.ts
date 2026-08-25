// v1 stub: exists so the adapter registry and health table already have the
// x_bookmarks slot. Not implemented in v1 by design (brief: fast-follow).
import type {
  AdapterContext,
  Capture,
  SourceAdapter,
} from "../../core/types.ts";

export interface XBookmarksAdapter extends SourceAdapter {
  readonly note: string;
}

export function createXBookmarksAdapter(): XBookmarksAdapter {
  return {
    name: "x_bookmarks",
    note: "v1 stub; see brief before implementing (1-2x/day jittered, high-water mark, back off on challenge)",
    async pull(_ctx: AdapterContext): Promise<Capture[]> {
      return [];
    },
  };
}
