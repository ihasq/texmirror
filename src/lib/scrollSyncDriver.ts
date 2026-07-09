export type ScrollSyncOwner = 'editor' | 'preview';

export interface EditorScrollDriverSample {
  centerLine: number;
  scrollRange: number;
  scrollTop: number;
}

export interface PreviewScrollDriverSample {
  scrollRange: number;
  scrollTop: number;
  sourceLine: number;
}

export interface ScrollFollowerTarget {
  top: number;
}

export interface ScrollSyncCheckpoint {
  editorTop: number;
  previewTop: number;
  sourceLine: number;
}

export interface ScrollSyncCheckpointPair {
  lower: ScrollSyncCheckpoint;
  upper: ScrollSyncCheckpoint;
}

interface PreviewFollower<Target extends ScrollFollowerTarget> {
  resolveScrollCheckpoints: (ownerTop: number, owner: ScrollSyncOwner) => ScrollSyncCheckpointPair | null;
  resolveSourceLineTarget: (line: number) => Target | null;
  scrollToDisplacement: (displacement: number) => void;
  scrollToScrollTop: (top: number) => void;
  scrollToSourceTarget: (target: Target) => void;
}

interface EditorFollower {
  resolveScrollCheckpoints: (ownerTop: number, owner: ScrollSyncOwner) => ScrollSyncCheckpointPair | null;
  scrollToDisplacement: (displacement: number) => void;
  scrollToScrollTop: (top: number) => void;
  scrollToSourceLine: (line: number) => void;
}

interface ScrollDisplacementUpdate {
  displacement: number;
}

interface ScrollDisplacementState {
  displacement: number;
  scrollRange: number;
  scrollTop: number;
}

const SCROLL_TOP_TOLERANCE = 0.5;
const DISPLACEMENT_TOLERANCE = 0.000001;

export class ScrollSyncDriver {
  private owner: ScrollSyncOwner = 'editor';
  private readonly displacement = new UnifiedScrollDisplacement();

  reset(): void {
    this.displacement.reset();
  }

  setOwner(owner: ScrollSyncOwner): void {
    if (this.owner === owner) return;

    this.owner = owner;
    this.reset();
  }

  followEditor<Target extends ScrollFollowerTarget>(
    sample: EditorScrollDriverSample,
    follower: PreviewFollower<Target>
  ): void {
    if (this.owner !== 'editor') return;

    const update = this.displacement.update(sample);
    if (!update) return;

    const checkpointTop = resolveCheckpointMappedTop(
      sample.scrollTop,
      'editor',
      follower.resolveScrollCheckpoints(sample.scrollTop, 'editor')
    );
    if (checkpointTop !== null) {
      follower.scrollToScrollTop(checkpointTop);
      return;
    }

    if (sample.scrollRange > 0) {
      follower.scrollToDisplacement(update.displacement);
      return;
    }

    const target = follower.resolveSourceLineTarget(sample.centerLine);
    if (!target) return;

    follower.scrollToSourceTarget(target);
  }

  followPreview(sample: PreviewScrollDriverSample, follower: EditorFollower): void {
    if (this.owner !== 'preview') return;

    const update = this.displacement.update(sample);
    if (!update) return;

    const checkpointTop = resolveCheckpointMappedTop(
      sample.scrollTop,
      'preview',
      follower.resolveScrollCheckpoints(sample.scrollTop, 'preview')
    );
    if (checkpointTop !== null) {
      follower.scrollToScrollTop(checkpointTop);
      return;
    }

    if (sample.scrollRange > 0) {
      follower.scrollToDisplacement(update.displacement);
    } else {
      follower.scrollToSourceLine(sample.sourceLine);
    }
  }
}

class UnifiedScrollDisplacement {
  private state: ScrollDisplacementState | null = null;

  reset(): void {
    this.state = null;
  }

  update(sample: { scrollRange: number; scrollTop: number }): ScrollDisplacementUpdate | null {
    const scrollRange = Math.max(0, sample.scrollRange);
    const scrollTop = clamp(sample.scrollTop, 0, scrollRange);
    const displacement = scrollRange > 0 ? scrollTop / scrollRange : 0;
    const previous = this.state;

    this.state = { displacement, scrollRange, scrollTop };

    if (!previous) {
      return { displacement };
    }

    const scrollTopChanged = Math.abs(scrollTop - previous.scrollTop) > SCROLL_TOP_TOLERANCE;
    const displacementChanged = Math.abs(displacement - previous.displacement) > DISPLACEMENT_TOLERANCE;
    const rangeChanged = scrollRange !== previous.scrollRange;
    if (!scrollTopChanged && !displacementChanged && !rangeChanged) {
      return null;
    }

    return { displacement };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function resolveCheckpointMappedTop(
  ownerTop: number,
  owner: ScrollSyncOwner,
  checkpoints: ScrollSyncCheckpointPair | null
): number | null {
  if (!checkpoints) return null;

  const fromLower = owner === 'editor' ? checkpoints.lower.editorTop : checkpoints.lower.previewTop;
  const fromUpper = owner === 'editor' ? checkpoints.upper.editorTop : checkpoints.upper.previewTop;
  const toLower = owner === 'editor' ? checkpoints.lower.previewTop : checkpoints.lower.editorTop;
  const toUpper = owner === 'editor' ? checkpoints.upper.previewTop : checkpoints.upper.editorTop;

  if (
    !Number.isFinite(fromLower) ||
    !Number.isFinite(fromUpper) ||
    !Number.isFinite(toLower) ||
    !Number.isFinite(toUpper)
  ) {
    return null;
  }

  const fromSpan = fromUpper - fromLower;
  if (Math.abs(fromSpan) < 0.5) {
    return toLower;
  }

  const ratio = clamp((ownerTop - fromLower) / fromSpan, 0, 1);
  return toLower + (toUpper - toLower) * ratio;
}
