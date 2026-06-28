/**
 * Panel data types.
 *
 * `Dataset` IS the canonical `VizArtifact` that `humanToViz()` produces and the
 * dashboard consumes — imported from @factstack/emit/pure so there is ONE
 * source of truth and zero cross-app coupling to apps/ui-remix.
 */
import type { VizArtifact } from '@factstack/emit/pure';

export type Dataset = VizArtifact;

export type AcquisitionKind = 'demo' | 'github' | 'local' | 'files';

/** A dataset plus how/where it came from — drives the panel's source chip. */
export interface LoadedDataset {
  dataset: Dataset;
  source: { kind: AcquisitionKind; label: string; at: number };
}
