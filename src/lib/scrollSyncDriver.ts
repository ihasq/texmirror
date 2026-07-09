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

export interface ScrollDriverPositionSample {
  scrollRange: number;
  scrollTop: number;
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
const OWNER_SWITCH_GUARD_MS = 350;
const START_SNAP_TOLERANCE = 1;
const START_SNAP_MIN_DISTANCE = 12;

interface OwnerSwitchGuard {
  owner: ScrollSyncOwner;
  scrollRange: number;
  scrollTop: number;
  startedAt: number;
}

export class ScrollSyncDriver {
  private owner: ScrollSyncOwner = 'editor';
  private readonly displacement = new UnifiedScrollDisplacement();
  private ownerSwitchGuard: OwnerSwitchGuard | null = null;

  reset(): void {
    this.displacement.reset();
    this.ownerSwitchGuard = null;
  }

  setOwner(owner: ScrollSyncOwner, seed?: ScrollDriverPositionSample | null): void {
    if (this.owner === owner) return;

    this.owner = owner;
    this.displacement.seed(seed);
    this.ownerSwitchGuard = seed ? createOwnerSwitchGuard(owner, seed) : null;
  }

  followEditor<Target extends ScrollFollowerTarget>(
    sample: EditorScrollDriverSample,
    follower: PreviewFollower<Target>
  ): void {
    if (this.owner !== 'editor') return;
    if (this.shouldIgnoreOwnerSwitchSample(sample)) return;

    const update = this.displacement.update(sample);
    if (!update) return;
    this.ownerSwitchGuard = null;

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
    if (this.shouldIgnoreOwnerSwitchSample(sample)) return;

    const update = this.displacement.update(sample);
    if (!update) return;
    this.ownerSwitchGuard = null;

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

  private shouldIgnoreOwnerSwitchSample(sample: ScrollDriverPositionSample): boolean {
    const guard = this.ownerSwitchGuard;
    if (!guard || guard.owner !== this.owner) return false;

    if (now() - guard.startedAt > OWNER_SWITCH_GUARD_MS) {
      this.ownerSwitchGuard = null;
      return false;
    }

    const scrollRange = Math.max(0, sample.scrollRange);
    const scrollTop = clamp(sample.scrollTop, 0, scrollRange);
    const rangeCollapsed = guard.scrollRange > START_SNAP_MIN_DISTANCE && scrollRange <= START_SNAP_TOLERANCE;
    const snappedToStart =
      guard.scrollTop > START_SNAP_MIN_DISTANCE &&
      scrollRange > START_SNAP_MIN_DISTANCE &&
      scrollTop <= START_SNAP_TOLERANCE;

    return rangeCollapsed || snappedToStart;
  }
}

class UnifiedScrollDisplacement {
  private state: ScrollDisplacementState | null = null;

  reset(): void {
    this.state = null;
  }

  seed(sample?: ScrollDriverPositionSample | null): void {
    this.state = sample ? toDisplacementState(sample) : null;
  }

  update(sample: ScrollDriverPositionSample): ScrollDisplacementUpdate | null {
    const state = toDisplacementState(sample);
    const previous = this.state;

    this.state = state;
    if (!previous) {
      return { displacement: state.displacement };
    }

    const scrollTopChanged = Math.abs(state.scrollTop - previous.scrollTop) > SCROLL_TOP_TOLERANCE;
    const displacementChanged = Math.abs(state.displacement - previous.displacement) > DISPLACEMENT_TOLERANCE;
    const rangeChanged = state.scrollRange !== previous.scrollRange;
    if (!scrollTopChanged && !displacementChanged && !rangeChanged) {
      return null;
    }

    return { displacement: state.displacement };
  }
}

function createOwnerSwitchGuard(owner: ScrollSyncOwner, sample: ScrollDriverPositionSample): OwnerSwitchGuard {
  const state = toDisplacementState(sample);
  return {
    owner,
    scrollRange: state.scrollRange,
    scrollTop: state.scrollTop,
    startedAt: now()
  };
}

function toDisplacementState(sample: ScrollDriverPositionSample): ScrollDisplacementState {
  const scrollRange = Math.max(0, sample.scrollRange);
  const scrollTop = clamp(sample.scrollTop, 0, scrollRange);
  const displacement = scrollRange > 0 ? scrollTop / scrollRange : 0;

  return { displacement, scrollRange, scrollTop };
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
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
