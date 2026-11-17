import { runOptimization } from './packer';
import {
  LoadingDirection,
  LoadingSpace,
  OptimizationMode,
  PackageSpec,
} from '../types/packvol';

export interface WorkerRequest {
  type: 'optimize' | 'cancel';
  jobId: string;
  payload?: {
    space: LoadingSpace;
    spaces?: LoadingSpace[];
    packages: PackageSpec[];
    mode: OptimizationMode;
    allowRotation: boolean;
    loadingDirection: LoadingDirection;
  };
}

let cancelledJobId: string | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'cancel') {
    cancelledJobId = msg.jobId;
    return;
  }

  if (msg.type === 'optimize' && msg.payload) {
    cancelledJobId = null;
    try {
      const result = runOptimization({
        ...msg.payload,
        onProgress: (pct, stage) => {
          self.postMessage({ type: 'progress', jobId: msg.jobId, pct, stage });
        },
        shouldCancel: () => cancelledJobId === msg.jobId,
      });

      if (cancelledJobId === msg.jobId) {
        self.postMessage({ type: 'cancelled', jobId: msg.jobId });
      } else {
        self.postMessage({ type: 'result', jobId: msg.jobId, result });
      }
    } catch (err) {
      self.postMessage({
        type: 'error',
        jobId: msg.jobId,
        error: err instanceof Error ? err.message : 'Optimization worker error',
      });
    }
  }
};
