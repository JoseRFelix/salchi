import type { TranscriptionModel } from "@t3tools/contracts";

export interface TranscriptionModelMetadata {
  readonly id: TranscriptionModel;
  readonly label: string;
  readonly downloadBytes: number;
  readonly downloadSizeLabel: string;
  readonly memorySizeLabel: string;
  readonly qualityLabel: string;
}

export const TRANSCRIPTION_MODELS = [
  {
    id: "tiny.en",
    label: "Tiny",
    downloadBytes: 77_704_715,
    downloadSizeLabel: "75 MB",
    memorySizeLabel: "~273 MB RAM",
    qualityLabel: "Fastest, lower accuracy",
  },
  {
    id: "base.en",
    label: "Base",
    downloadBytes: 147_964_211,
    downloadSizeLabel: "142 MB",
    memorySizeLabel: "~388 MB RAM",
    qualityLabel: "Balanced",
  },
  {
    id: "small.en",
    label: "Small",
    downloadBytes: 487_614_201,
    downloadSizeLabel: "466 MB",
    memorySizeLabel: "~852 MB RAM",
    qualityLabel: "More accurate, slower",
  },
] as const satisfies ReadonlyArray<TranscriptionModelMetadata>;

export function findTranscriptionModel(id: TranscriptionModel): TranscriptionModelMetadata {
  return TRANSCRIPTION_MODELS.find((model) => model.id === id) ?? TRANSCRIPTION_MODELS[1];
}

export function isTranscriptionModel(value: string): value is TranscriptionModel {
  return TRANSCRIPTION_MODELS.some((model) => model.id === value);
}
