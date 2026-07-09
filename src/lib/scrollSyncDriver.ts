export type ScrollSyncOwner = 'editor' | 'preview';

export interface EditorScrollDriverSample {
  centerLine: number;
  scrollTop: number;
}

export interface PreviewScrollDriverSample {
  scrollTop: number;
  sourceLine: number;
}

export interface ScrollFollowerTarget {
  top: number;
}

interface PreviewFollower<Target extends ScrollFollowerTarget> {
  resolveSourceLineTarget: (line: number) => Target | null;
  scrollToSourceTarget: (target: Target) => void;
}

interface EditorFollower {
  revealSourceLine: (line: number) => void;
}

interface DirectionalCheckpointOptions {
  driverGap: number;
  driverTolerance: number;
  passFirst: boolean;
  targetGap: number;
  targetTolerance: number;
}

interface DirectionalCheckpointState {
  direction: ScrollDirection;
  driver: number;
  target: number;
}

type ScrollDirection = 'forward' | 'backward' | 'none';

export class ScrollSyncDriver {
  private owner: ScrollSyncOwner = 'editor';
  private readonly editorToPreview = new DirectionalCheckpoint({
    driverGap: 1,
    driverTolerance: 1,
    passFirst: false,
    targetGap: 18,
    targetTolerance: 4
  });
  private readonly previewToEditor = new DirectionalCheckpoint({
    driverGap: 8,
    driverTolerance: 1,
    passFirst: true,
    targetGap: 1,
    targetTolerance: 0
  });

  reset(): void {
    this.editorToPreview.reset();
    this.previewToEditor.reset();
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

    const target = follower.resolveSourceLineTarget(sample.centerLine);
    if (!target) return;

    if (this.editorToPreview.shouldPass(sample.scrollTop, target.top)) {
      follower.scrollToSourceTarget(target);
    }
  }

  followPreview(sample: PreviewScrollDriverSample, follower: EditorFollower): void {
    if (this.owner !== 'preview') return;

    if (this.previewToEditor.shouldPass(sample.scrollTop, sample.sourceLine)) {
      follower.revealSourceLine(sample.sourceLine);
    }
  }
}

class DirectionalCheckpoint {
  private checkpoint: DirectionalCheckpointState | null = null;

  constructor(private readonly options: DirectionalCheckpointOptions) {}

  reset(): void {
    this.checkpoint = null;
  }

  shouldPass(driver: number, target: number): boolean {
    const checkpoint = this.checkpoint;
    if (!checkpoint) {
      this.checkpoint = { direction: 'none', driver, target };
      return this.options.passFirst;
    }

    const direction = getDirection(driver - checkpoint.driver, this.options.driverTolerance);
    if (direction === 'none') return false;

    if (checkpoint.direction !== 'none' && direction !== checkpoint.direction) {
      this.checkpoint = { direction, driver, target };
      return true;
    }

    const targetDelta = target - checkpoint.target;
    if (movesAgainstDirection(targetDelta, direction, this.options.targetTolerance)) {
      return false;
    }

    const driverDelta = Math.abs(driver - checkpoint.driver);
    const targetDistance = Math.abs(targetDelta);
    if (driverDelta < this.options.driverGap || targetDistance < this.options.targetGap) {
      return false;
    }

    this.checkpoint = { direction, driver, target };
    return true;
  }
}

function getDirection(delta: number, tolerance: number): ScrollDirection {
  if (Math.abs(delta) <= tolerance) return 'none';

  return delta > 0 ? 'forward' : 'backward';
}

function movesAgainstDirection(
  delta: number,
  direction: Exclude<ScrollDirection, 'none'>,
  tolerance: number
): boolean {
  return direction === 'forward' ? delta < -tolerance : delta > tolerance;
}
